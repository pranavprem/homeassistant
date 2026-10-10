"""Deterministic offline behavior tests; no HA credentials or external requests."""

from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import airspace as a


NOW = 1_800_000_000.0


class FakeClock:
    def __init__(self):
        self.wall = NOW
        self.ticks = 1000.0

    def now(self):
        return self.wall

    def monotonic(self):
        return self.ticks

    def advance(self, seconds):
        self.wall += seconds
        self.ticks += seconds


class FakeHttp:
    def __init__(self, responses=()):
        self.responses = list(responses)
        self.requests = []

    def request(self, method, url, **kwargs):
        self.requests.append((method, url, kwargs))
        if not self.responses:
            raise AssertionError("unexpected HTTP request")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if callable(response):
            return response()
        return response


class FakeHA:
    def __init__(self, home=None):
        self.position = home or a.Position(0, 0)
        self.home_calls = 0
        self.messages = []
        self.failure = None

    def home(self):
        self.home_calls += 1
        return self.position

    def publish(self, topic, payload, *, retain):
        if self.failure:
            raise self.failure
        self.messages.append((topic, payload, retain))


def plane(**overrides):
    result = {"hex": "abc001", "flight": "DEMO123 ", "lat": 0.01, "lon": 0,
              "seen_pos": 1, "alt_baro": 12000, "gs": 230, "track": 90,
              "baro_rate": -500, "r": "N123EX", "t": "B738"}
    result.update(overrides)
    return result


def feed(aircraft=None, now=NOW, **overrides):
    result = {"now": now * 1000, "msg": "No error", "ac": [plane()] if aircraft is None else aircraft}
    result.update(overrides)
    return result


def route(callsign="DEMO123", **overrides):
    result = {"callsign": callsign, "airport_codes": "XAAA-XBBB", "number": "123", "airline_code": "DEM",
              "_airports": [{"icao": "XAAA", "iata": "AAA", "name": "Example West", "lat": 0, "lon": -1},
                            {"icao": "XBBB", "iata": "BBB", "name": "Example East", "lat": 0, "lon": 1}]}
    result.update(overrides)
    return result


def attributes(aircraft=None, now=NOW):
    _, records = a.normalize_feed(feed(aircraft, now), a.Position(0, 0), a.Settings(), now)
    return {"schema_version": 1, "provider": "ADSB.lol", "attribution": a.ATTRIBUTION,
            "updated_at": a.iso(now), "radius_km": 25, "overhead_radius_km": 3,
            "aircraft": records, "recent": []}


class GeometryTests(unittest.TestCase):
    def test_zero_coordinates_are_valid_and_same_point_is_zero(self):
        self.assertEqual(a.Position.parse(0, 0), a.Position(0, 0))
        self.assertEqual(a.geometry(a.Position(0, 0), a.Position(0, 0)), (0, 0))

    def test_cardinal_distances_and_bearings(self):
        for point, bearing in ((a.Position(1, 0), 0), (a.Position(0, 1), 90),
                               (a.Position(-1, 0), 180), (a.Position(0, -1), 270)):
            distance, actual = a.geometry(a.Position(0, 0), point)
            self.assertAlmostEqual(distance, 111.19508, places=4)
            self.assertAlmostEqual(actual, bearing, places=8)

    def test_dateline_is_short_path(self):
        distance, bearing = a.geometry(a.Position(0, 179.9), a.Position(0, -179.9))
        self.assertAlmostEqual(distance, 22.239016, places=4)
        self.assertEqual(bearing, 90)

    def test_poles_and_antipodes_are_finite(self):
        for x, y in ((a.Position(90, 0), a.Position(90, 179)), (a.Position(0, 0), a.Position(0, 180))):
            distance, bearing = a.geometry(x, y)
            self.assertTrue(math.isfinite(distance))
            self.assertTrue(0 <= bearing < 360)

    def test_invalid_coordinates_rejected_not_echoed(self):
        for lat, lon in ((91, 0), (-91, 0), (0, 181), (True, 1), (1, None), (float("nan"), 0), ("1", 0)):
            with self.assertRaisesRegex(a.Failure, "^invalid_position$"):
                a.Position.parse(lat, lon)

    def test_coarse_query_padding_contains_whole_local_circle(self):
        # Including equator, poles, negative rounding, and the dateline.
        for home in (a.Position(0.049, 0.049), a.Position(-45.049, -45.049),
                     a.Position(89.99, 179.99), a.Position(0.051, -179.951)):
            parts = a.point_url(home, 25).split("/")
            lat, lon, nautical_miles = float(parts[-3]), float(parts[-2]), int(parts[-1])
            self.assertLessEqual(a.geometry(home, a.Position(lat, lon))[0] + 25, nautical_miles * 1.852)
            self.assertRegex(parts[-3], r"^-?\d+\.\d$")
            self.assertRegex(parts[-2], r"^-?\d+\.\d$")
            # Padding is independent of the exact home-to-grid displacement.
            self.assertEqual(nautical_miles, 18)

    def test_inverse_and_segment_bounds(self):
        home = a.Position(10, 179.8)
        point = a.destination(home, 40, 89)
        distance, bearing = a.geometry(home, point)
        self.assertAlmostEqual(distance, 40)
        self.assertAlmostEqual(bearing, 89)
        self.assertAlmostEqual(a.segment_distance(a.Position(0, 180), a.Position(0, 179), a.Position(0, -179)), 0)
        self.assertGreater(a.segment_distance(a.Position(0, 3), a.Position(0, -1), a.Position(0, 1)), 200)
        self.assertGreater(a.segment_distance(a.Position(2, 0), a.Position(0, -1), a.Position(0, 1)), 200)


class FeedTests(unittest.TestCase):
    def normalize(self, data):
        return a.normalize_feed(data, a.Position(0, 0), a.Settings(), NOW)[1]

    def test_normalized_fields_and_source_timestamp(self):
        item = self.normalize(feed())[0]
        self.assertEqual(item["callsign"], "DEMO123")
        self.assertAlmostEqual(item["distance_km"], 1.112, places=3)
        self.assertEqual(item["bearing_deg"], 0)
        self.assertEqual(item["altitude_ft"], 12000)
        self.assertTrue(item["overhead"])
        self.assertEqual(item["last_seen"], a.iso(NOW - 1))

    def test_empty_fresh_provider_is_valid(self):
        self.assertEqual(self.normalize(feed([])), [])

    def test_no_private_raw_fields_forwarded(self):
        item = self.normalize(feed([plane(owner="PRIVATE", pilot="PRIVATE", latitude=12, token="PRIVATE", url="https://invalid.example")]))[0]
        for forbidden in ("lat", "lon", "latitude", "longitude", "owner", "pilot", "token", "url"):
            self.assertNotIn(forbidden, item)
        self.assertNotIn("PRIVATE", json.dumps(item))

    def test_ground_stale_and_outside_radius_excluded(self):
        self.assertEqual(self.normalize(feed([plane(alt_baro="ground"), plane(hex="abc002", seen_pos=61),
                                              plane(hex="abc003", lon=1), plane(hex="abc004", on_ground=True)])), [])

    def test_payload_age_and_position_age_are_combined(self):
        self.assertEqual(self.normalize(feed([plane(seen_pos=31)], NOW - 30)), [])
        self.assertEqual(len(self.normalize(feed([plane(seen_pos=30)], NOW - 30))), 1)

    def test_old_and_future_payloads_fail_closed(self):
        for delta in (-60.001, 60.001, -1e6):
            with self.assertRaisesRegex(a.Failure, "^stale_feed$"):
                self.normalize(feed(now=NOW + delta))

    def test_malformed_envelopes_never_turn_into_clear_skies(self):
        for malformed in (None, [], {}, {"ac": [], "now": True}, feed(ac=None), feed(msg="error"),
                          feed(now=NOW, ac=[None, {}, plane(lat=91)]), feed(ac=[plane(seen_pos=-1)])):
            with self.assertRaises(a.Failure):
                self.normalize(malformed)

    def test_seconds_epoch_accepted_without_retimestamp(self):
        data = feed(now=NOW - 10)
        data["now"] = NOW - 10
        self.assertEqual(self.normalize(data)[0]["last_seen"], a.iso(NOW - 11))

    def test_optional_fields_invalid_values_omitted(self):
        item = self.normalize(feed([plane(gs=float("inf"), track=-1, alt_baro="12345", baro_rate=True,
                                         flight="<script>", r="R" * 17, t="../X")]))[0]
        for key in ("speed_kts", "track_deg", "altitude_ft", "vertical_rate_fpm", "callsign", "registration", "aircraft_type"):
            self.assertNotIn(key, item)

    def test_geometric_altitude_not_substituted_for_baro(self):
        item = self.normalize(feed([plane(alt_baro=None, alt_geom=14000, geom_rate=700)]))[0]
        self.assertNotIn("altitude_ft", item)
        self.assertEqual(item["vertical_rate_fpm"], -500)

    def test_dedup_keeps_freshest_and_nearest_50_sorted(self):
        many = [plane(hex=f"{i:06x}", lat=i / 1000) for i in range(1, 70)]
        many.append(plane(hex="000001", lat=0.002, seen_pos=0))
        records = self.normalize(feed(many))
        self.assertEqual(len(records), 50)
        self.assertEqual(len({v["hex"] for v in records}), 50)
        self.assertEqual(next(v for v in records if v["hex"] == "000001")["last_seen"], a.iso(NOW))
        self.assertEqual([v["distance_km"] for v in records], sorted(v["distance_km"] for v in records))

    def test_valid_rows_survive_malformed_neighbors(self):
        self.assertEqual(len(self.normalize(feed([None, plane(hex="badhex"), plane()]))), 1)

    def test_extreme_json_numbers_are_rejected_without_overflow(self):
        self.assertIsNone(a.number(10 ** 1000, -90, 90))
        self.assertEqual(len(self.normalize(feed([plane(lat=10 ** 1000), plane(hex="abc002")]))), 1)


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.home = a.Position(0, 0)
        self.items = attributes()["aircraft"]

    def test_route_only_allowlisted_fields_and_reported_label(self):
        raw = route(owner="PRIVATE", token="PRIVATE", url="https://invalid.example")
        http = FakeHttp([a.Response(200, raw)])
        routes = a.Routes(http, self.clock)
        routes.enrich(self.items, self.home)
        result = self.items[0]["route"]
        self.assertEqual(result["source"], "VRS via ADSB.lol")
        self.assertEqual(result["status"], "reported")
        self.assertEqual(result["origin"], "AAA")
        self.assertEqual(result["destination"], "BBB")
        self.assertNotIn("airline", result)
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertNotIn("lat", result)
        self.assertNotIn("lon", result)
        self.assertEqual(http.requests[0][1], "https://vrs-standing-data.adsb.lol/routes/DE/DEMO123.json")
        self.assertNotIn("headers", http.requests[0][2])

    def test_exact_callsign_airport_chain_and_positions_required(self):
        for raw in (route(callsign="DEMO999"), route(airport_codes="XBBB-XAAA"), route(_airports=[None, {}]),
                    route(_airports=[{"icao": "XAAA", "lat": 999, "lon": 0}] * 2)):
            self.assertIsNone(a.parse_route(raw, "DEMO123"))

    def test_route_far_from_reported_aircraft_is_omitted(self):
        routes = a.Routes(FakeHttp([a.Response(200, route())]), self.clock)
        routes.enrich(self.items, a.Position(15, 15))
        self.assertNotIn("route", self.items[0])

    def test_positive_and_negative_cache_expire(self):
        http = FakeHttp([a.Response(200, route()), a.Response(404), a.Response(404)])
        routes = a.Routes(http, self.clock, positive_ttl=60, negative_ttl=30)
        routes.enrich(self.items, self.home)
        routes.enrich(self.items, self.home)
        self.assertEqual(len(http.requests), 1)
        self.clock.advance(61)
        fresh = attributes()["aircraft"]
        routes.enrich(fresh, self.home)
        self.assertNotIn("route", fresh[0])
        routes.enrich(fresh, self.home)
        self.assertEqual(len(http.requests), 2)
        self.clock.advance(31)
        routes.enrich(fresh, self.home)
        self.assertEqual(len(http.requests), 3)

    def test_two_lookups_per_cycle_and_bounded_cache(self):
        http = FakeHttp([a.Response(404)] * 6)
        routes = a.Routes(http, self.clock, capacity=3)
        for group in range(3):
            items = [dict(self.items[0], callsign=f"DEMO{group}{i}") for i in range(4)]
            routes.enrich(items, self.home)
            self.assertEqual(len(http.requests), (group + 1) * 2)
            self.assertLessEqual(len(routes.cache), 3)

    def test_429_retry_after_blocks_further_route_calls_not_positions(self):
        http = FakeHttp([a.Response(429, headers={"Retry-After": "600"}), a.Response(404)])
        routes = a.Routes(http, self.clock)
        routes.enrich(self.items, self.home)
        self.clock.advance(599)
        routes.enrich(self.items, self.home)
        self.assertEqual(len(http.requests), 1)
        self.clock.advance(1)
        routes.enrich(self.items, self.home)
        self.assertEqual(len(http.requests), 2)

    def test_retry_after_http_date_and_backoff_cap(self):
        value = datetime.fromtimestamp(NOW + 7200, timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")
        retry = a.retry_after(a.Response(503, headers={"retry-after": value}), NOW)
        self.assertEqual(retry, 7200)
        backoff = a.Backoff(self.clock)
        backoff.fail(a.Failure("http_error", retry_after=retry))
        self.assertEqual(backoff.until - self.clock.monotonic(), 7200)
        for _ in range(20):
            backoff.fail(a.Failure("transport_error"))
        self.assertEqual(backoff.until - self.clock.monotonic(), 3600)
        backoff.success()
        self.assertTrue(backoff.ready())

    def test_retry_after_malformed_values_do_not_explode(self):
        for raw in ("not a date", "Infinity", "NaN", "-3", ""):
            self.assertEqual(a.retry_after(a.Response(429, headers={"Retry-After": raw}), NOW), 0)

    def test_markup_and_overlong_unicode_names_are_not_exported(self):
        raw = route()
        raw["_airports"][0]["name"] = "<script>alert(1)</script>"
        raw["_airports"][1]["name"] = "😀" * 80
        result = a.parse_route(raw, "DEMO123")
        self.assertNotIn("origin_name", result.fields)
        self.assertNotIn("destination_name", result.fields)
        self.assertIsNone(a.label("\ud800"))


class HistoryTests(unittest.TestCase):
    def test_only_overhead_in_last_30_minutes_and_closest_distance(self):
        history = a.History()
        item = attributes()["aircraft"][0]
        history.update([item, dict(item, hex="abc002", overhead=False)], NOW)
        closer = dict(item, distance_km=0.5, last_seen=a.iso(NOW + 30))
        history.update([closer], NOW + 30)
        farther = dict(closer, distance_km=1, last_seen=a.iso(NOW + 60))
        recent = history.update([farther], NOW + 60)
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0]["closest_distance_km"], 0.5)
        self.assertEqual(recent[0]["last_seen"], farther["last_seen"])
        self.assertEqual(history.update([], NOW + 1861), [])

    def test_history_maximum_twelve_and_never_daily_count(self):
        history = a.History()
        item = attributes()["aircraft"][0]
        result = history.update([dict(item, hex=f"{i:06x}") for i in range(20)], NOW)
        self.assertEqual(len(result), 12)
        self.assertEqual(len(history.records), 20)
        self.assertFalse(any("daily" in key for record in result for key in record))

    def test_closest_approach_expires_even_when_same_aircraft_stays_overhead(self):
        history = a.History()
        item = attributes()["aircraft"][0]
        history.update([dict(item, distance_km=0.1, last_seen=a.iso(NOW))], NOW)
        history.update([dict(item, distance_km=2, last_seen=a.iso(NOW + 1200))], NOW + 1200)
        recent = history.update([dict(item, distance_km=2.5, last_seen=a.iso(NOW + 1860))], NOW + 1860)
        self.assertEqual(recent[0]["closest_distance_km"], 2)
        recent = history.update([], NOW + 3001)
        self.assertEqual(recent[0]["closest_distance_km"], 2.5)

    def test_top_twelve_display_does_not_forget_a_returning_aircraft(self):
        history = a.History()
        item = attributes()["aircraft"][0]
        history.update([dict(item, distance_km=0.1, last_seen=a.iso(NOW))], NOW)
        history.update([dict(item, hex=f"{i:06x}", last_seen=a.iso(NOW + 60)) for i in range(12)], NOW + 60)
        recent = history.update([dict(item, distance_km=2, last_seen=a.iso(NOW + 840))], NOW + 840)
        self.assertEqual(recent[0]["closest_distance_km"], 0.1)

    def test_internal_history_remains_bounded(self):
        history = a.History()
        item = attributes()["aircraft"][0]
        history.update([dict(item, hex=f"{i:06x}") for i in range(300)], NOW)
        self.assertEqual(len(history.records), a.MAX_HISTORY_TRACKS)
        self.assertEqual(len(history.samples), a.MAX_HISTORY_TRACKS)


class HttpTests(unittest.TestCase):
    def test_truncated_body_and_protocol_errors_are_sanitized_transport_failures(self):
        for error in (a.http.client.IncompleteRead(b"PRIVATE"), a.http.client.BadStatusLine("PRIVATE")):
            client = a.Http()
            client.opener = MagicMock()
            client.opener.open.return_value.__enter__.return_value.read.side_effect = error
            with self.assertRaises(a.Failure) as raised:
                client.request("GET", "https://example.invalid/")
            self.assertEqual(raised.exception.code, "transport_error")

    def test_truncated_optional_route_keeps_fresh_positions(self):
        client = a.Http()
        client.opener = MagicMock()
        client.opener.open.return_value.__enter__.return_value.read.side_effect = a.http.client.IncompleteRead(b"PRIVATE")
        clock = FakeClock()
        positions = attributes()["aircraft"]
        routes = a.Routes(client, clock)
        routes.enrich(positions, a.Position(0, 0))
        self.assertEqual(len(positions), 1)
        self.assertNotIn("route", positions[0])
        self.assertFalse(routes.backoff.ready())


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ha = FakeHA()
        self.publisher = a.Publisher(self.ha, a.Settings(), self.clock)

    def test_discovery_state_attributes_expiry_and_retention(self):
        self.publisher.discover()
        self.publisher.publish(attributes())
        discovery, state, availability = self.ha.messages
        config = json.loads(discovery[1])
        self.assertTrue(discovery[2])
        self.assertEqual(config["expire_after"], 180)
        self.assertEqual(config["default_entity_id"], "sensor.demo_sky_airspace")
        self.assertEqual(config["json_attributes_topic"], config["state_topic"])
        self.assertEqual(config["value_template"], "{{ value_json.count }}")
        self.assertEqual(config["json_attributes_template"], "{{ value_json.attributes | tojson }}")
        self.assertEqual(json.loads(state[1])["count"], 1)
        self.assertEqual(json.loads(state[1])["attributes"], attributes())
        self.assertFalse(state[2])
        self.assertEqual(availability[1:], ("online", False))

    def test_discovery_refresh_and_stop_offline_no_retention(self):
        self.publisher.discover()
        self.clock.advance(599)
        self.publisher.discover()
        self.assertEqual(len(self.ha.messages), 1)
        self.clock.advance(1)
        self.publisher.discover()
        self.publisher.offline()
        self.assertEqual(len(self.ha.messages), 3)
        self.assertEqual(self.ha.messages[-1][1:], ("offline", False))

    def test_stale_state_never_published_or_marked_online(self):
        with self.assertRaisesRegex(a.Failure, "stale_feed"):
            self.publisher.publish(attributes(now=NOW - 61))
        self.assertEqual(self.ha.messages, [])

    def test_topic_and_id_injection_rejected(self):
        for value in ("../../bad", "thing/commands", "bad#", "bad+", "Capital", "x" * 64):
            with self.assertRaises(a.Failure):
                a.Settings(object_id=value)
            with self.assertRaises(a.Failure):
                a.Settings(unique_id=value)
        with self.assertRaisesRegex(a.Failure, "invalid_topic"):
            self.publisher._publish("other/device/set", "ON")
        self.assertEqual(self.ha.messages, [])

    def test_oversized_payload_is_not_sent(self):
        large = attributes()
        large["attribution"] = "x" * a.MAX_STATE_BYTES
        with self.assertRaisesRegex(a.Failure, "state_too_large"):
            self.publisher.publish(large)
        self.assertEqual(self.ha.messages, [])

    def test_rollback_removes_only_own_discovery(self):
        self.publisher.remove()
        self.assertEqual(self.ha.messages[0][1:], ("offline", False))
        self.assertEqual(self.ha.messages[1], ("homeassistant/sensor/demo_sky_airspace/config", "", True))


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ha = FakeHA()
        self.settings = a.Settings(routes=False)

    def runner(self, responses, dry_run=False):
        http = FakeHttp(responses)
        collector = a.Collector(self.ha, http, self.settings, self.clock)
        return a.Runner(collector, a.Publisher(self.ha, self.settings, self.clock), dry_run=dry_run), http

    def test_fresh_failure_backoff_and_recovery_transitions(self):
        runner, http = self.runner([a.Response(200, feed()), a.Response(503, headers={"Retry-After": "300"}), a.Response(200, feed([], NOW + 360))])
        self.assertEqual(runner.cycle()["status"], "online")
        original = self.ha.messages[-2][1]
        self.clock.advance(60)
        self.assertEqual(runner.cycle()["status"], "offline")
        self.assertIsNone(runner.last_attributes)
        self.assertEqual(self.ha.messages[-1][1], "offline")
        self.clock.advance(299)
        self.assertEqual(runner.cycle()["status"], "offline")
        self.assertEqual(len(http.requests), 2)
        self.clock.advance(1)
        result = runner.cycle()
        self.assertEqual(result["status"], "online")
        self.assertEqual(result["nearby"], 0)
        self.assertEqual(len([m for m in self.ha.messages if m[1] == original]), 1)

    def test_repeated_snapshot_is_not_restamped(self):
        runner, _ = self.runner([a.Response(200, feed()), a.Response(200, feed())])
        runner.cycle()
        self.clock.advance(1)
        self.assertEqual(runner.cycle()["reason"], "repeated_feed")
        self.assertEqual(len([m for m in self.ha.messages if m[0].endswith("/state")]), 1)

    def test_dry_run_is_read_only_and_summary_contains_only_counts(self):
        runner, http = self.runner([a.Response(200, feed())], dry_run=True)
        result = runner.cycle()
        self.assertEqual(result, {"status": "dry_run", "nearby": 1, "overhead": 1, "recent": 1, "reported_routes": 0})
        self.assertEqual(self.ha.messages, [])
        self.assertTrue(all(method == "GET" for method, _, _ in http.requests))

    def test_home_is_read_in_memory_rechecked_hourly_and_history_reset(self):
        runner, _ = self.runner([a.Response(200, feed()), a.Response(200, feed([], NOW + 3600))])
        runner.cycle()
        self.assertEqual(self.ha.home_calls, 1)
        self.ha.position = a.Position(1, 1)
        self.clock.advance(3600)
        runner.cycle()
        self.assertEqual(self.ha.home_calls, 2)
        self.assertEqual(runner.last_attributes["recent"], [])

    def test_route_failure_does_not_make_fresh_positions_offline(self):
        http = FakeHttp([a.Response(200, feed()), a.Response(503)])
        collector = a.Collector(self.ha, http, a.Settings(), self.clock)
        result = collector.collect()
        self.assertEqual(len(result["aircraft"]), 1)
        self.assertNotIn("route", result["aircraft"][0])

    def test_slow_enrichment_never_relabels_expired_positions_as_live(self):
        def delayed_route():
            self.clock.advance(5)
            return a.Response(404)
        http = FakeHttp([a.Response(200, feed(now=NOW - 59)), delayed_route])
        collector = a.Collector(self.ha, http, a.Settings(), self.clock)
        with self.assertRaisesRegex(a.Failure, "stale_feed"):
            collector.collect()

    def test_publish_failure_does_not_report_online(self):
        runner, _ = self.runner([a.Response(200, feed())])
        self.ha.failure = a.Failure("ha_auth_error")
        self.assertEqual(runner.cycle()["reason"], "ha_auth_error")
        self.assertIsNone(runner.last_attributes)

    def test_auth_expiry_during_failure_marker_is_fatal_too(self):
        runner, _ = self.runner([a.Response(503)])
        runner.publisher.last_discovery = self.clock.monotonic()
        self.ha.failure = a.Failure("ha_auth_error")
        self.assertEqual(runner.cycle()["reason"], "ha_auth_error")


class BoundaryTests(unittest.TestCase):
    def test_ha_auth_sent_only_to_fixed_paths_and_never_external_provider(self):
        http = FakeHttp([a.Response(200, {"latitude": 0, "longitude": 0}), a.Response(200, [])])
        ha = a.HomeAssistant("https://ha.example.invalid/", "fictional-token", http, FakeClock())
        self.assertEqual(ha.home(), a.Position(0, 0))
        ha.publish("agraharam/airspace/demo_sky_airspace/state", "0", retain=False)
        self.assertEqual([r[1] for r in http.requests], ["https://ha.example.invalid/api/config", "https://ha.example.invalid/api/services/mqtt/publish"])
        self.assertEqual(http.requests[1][2]["headers"], {"Authorization": "Bearer fictional-token"})

    def test_ha_redirect_is_failure_and_auth_error_has_no_details(self):
        for status in (301, 302, 401, 403):
            http = FakeHttp([a.Response(status, {"token": "PRIVATE", "url": "PRIVATE"})])
            ha = a.HomeAssistant("https://ha.example.invalid", "fictional-token", http, FakeClock())
            with self.assertRaises(a.Failure) as caught:
                ha.home()
            self.assertIn(str(caught.exception), ("ha_auth_error", "http_error"))
            self.assertNotIn("PRIVATE", str(caught.exception))
            self.assertEqual(len(http.requests), 1)
        self.assertIsNone(a.NoRedirect().redirect_request(None, None, 302, "", {}, "https://invalid.example"))

    def test_configuration_rejects_userinfo_query_and_fragment(self):
        for url in ("https://user:secret@ha.example.invalid", "https://ha.example.invalid?q=x", "https://ha.example.invalid/#x",
                    "file:///private", "http://ha.example.invalid/api", "http://ha.example.invalid:invalid"):
            with self.assertRaisesRegex(a.Failure, "invalid_ha_configuration"):
                a.HomeAssistant(url, "fictional-token", FakeHttp(), FakeClock())

    def test_invalid_radius_and_poll_values_fail_closed(self):
        for kwargs in ({"radius_km": 0}, {"radius_km": float("nan")}, {"overhead_radius_km": 26}, {"poll_seconds": 1}):
            with self.assertRaises(a.Failure):
                a.Settings(**kwargs)

    def test_private_output_is_exclusive_0600_and_contains_only_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "proof.json"
            a.private_output(str(path), attributes())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), attributes())
            with self.assertRaisesRegex(a.Failure, "private_output_failed"):
                a.private_output(str(path), attributes())
            link = Path(directory) / "link.json"
            link.symlink_to(path)
            with self.assertRaises(a.Failure):
                a.private_output(str(link), attributes())

    def test_main_missing_environment_does_not_echo_secret(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"HA_URL": "bad-url-PRIVATE", "HA_TOKEN": "secret-PRIVATE"}), redirect_stdout(output):
            result = a.main(["--once", "--dry-run"])
        self.assertEqual(result, 1)
        self.assertEqual(json.loads(output.getvalue()), {"status": "error", "reason": "invalid_ha_configuration"})

    def test_main_fatal_ha_auth_exits_without_waiting_for_next_cycle(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"HA_URL": "https://ha.example.invalid", "HA_TOKEN": "fictional-token"}), \
             patch.object(a, "Http", return_value=FakeHttp([a.Response(401), a.Response(401)])), \
             patch.object(a.signal, "signal"), redirect_stdout(output):
            result = a.main([])
        self.assertEqual(result, 1)
        self.assertEqual(json.loads(output.getvalue())["reason"], "ha_auth_error")


if __name__ == "__main__":
    unittest.main()
