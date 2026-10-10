#!/usr/bin/env python3
"""Read-only aircraft telemetry collector. Runtime and tests use only Python's stdlib."""

from __future__ import annotations

import argparse
import http.client
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import math
import os
import re
import signal
import threading
import time
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


EARTH_KM = 6371.0088
POSITION_MAX_AGE = 60
FUTURE_TOLERANCE = 60
EXPIRY_SECONDS = 180
HISTORY_SECONDS = 1800
MAX_AIRCRAFT = 50
MAX_RECENT = 12
MAX_HISTORY_TRACKS = 256
MAX_RESPONSE_BYTES = 2_000_000
MAX_STATE_BYTES = 60_000
ATTRIBUTION = (
    "Aircraft positions: ADSB.lol (ODbL 1.0); "
    "reported routes: VRS via ADSB.lol (CC0)"
)
SAFE_ID = re.compile(r"[a-z][a-z0-9_]{0,62}\Z")
CALLSIGN = re.compile(r"[A-Z0-9]{2,8}\Z")
HEX = re.compile(r"[0-9a-f]{6}\Z")


class Failure(Exception):
    """Only fixed, non-sensitive error codes may cross the logging boundary."""

    def __init__(self, code: str, *, retry_after: float = 0):
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


def number(value: Any, low: float, high: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not low <= value <= high or not math.isfinite(value):
        return None
    return float(value)


def label(value: Any, maximum: int = 80) -> str | None:
    if not isinstance(value, str):
        return None
    result = value.strip()
    if not result or len(result) > maximum:
        return None
    if any(not c.isprintable() or c in '<>"{}\\' for c in result):
        return None
    if len(result.encode("utf-8")) > 160:
        return None
    return result


def identifier(value: Any, pattern: re.Pattern[str]) -> str | None:
    if not isinstance(value, str):
        return None
    result = value.strip().upper()
    return result if pattern.fullmatch(result) else None


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def epoch(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


@dataclass(frozen=True)
class Position:
    lat: float = field(repr=False)
    lon: float = field(repr=False)

    @classmethod
    def parse(cls, lat: Any, lon: Any) -> Position:
        lat = number(lat, -90, 90)
        lon = number(lon, -180, 180)
        if lat is None or lon is None:
            raise Failure("invalid_position")
        return cls(lat, lon)


def geometry(origin: Position, target: Position) -> tuple[float, float]:
    """Great-circle distance and initial true-north bearing; dateline safe."""
    a, b = math.radians(origin.lat), math.radians(target.lat)
    delta = math.radians(target.lon - origin.lon)
    h = math.sin((b - a) / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(delta / 2) ** 2
    distance = EARTH_KM * 2 * math.asin(math.sqrt(min(1, max(0, h))))
    y = math.sin(delta) * math.cos(b)
    x = math.cos(a) * math.sin(b) - math.sin(a) * math.cos(b) * math.cos(delta)
    return distance, math.degrees(math.atan2(y, x)) % 360


def destination(origin: Position, distance_km: float, bearing_deg: float) -> Position:
    """Inverse of geometry, used only in memory to sanity-check reported routes."""
    a, b, angle = math.radians(origin.lat), math.radians(origin.lon), math.radians(bearing_deg)
    d = distance_km / EARTH_KM
    lat = math.asin(max(-1, min(1, math.sin(a) * math.cos(d) + math.cos(a) * math.sin(d) * math.cos(angle))))
    lon = b + math.atan2(math.sin(angle) * math.sin(d) * math.cos(a), math.cos(d) - math.sin(a) * math.sin(lat))
    return Position(math.degrees(lat), (math.degrees(lon) + 180) % 360 - 180)


def segment_distance(point: Position, start: Position, end: Position) -> float:
    """Shortest distance to a minor great-circle segment, including its endpoints."""
    length, heading = geometry(start, end)
    from_start, to_point = geometry(start, point)
    endpoint_distance = min(from_start, geometry(end, point)[0])
    if length < 0.001 or length > math.pi * EARTH_KM - 1:
        return endpoint_distance
    delta = from_start / EARTH_KM
    difference = math.radians(to_point - heading)
    cross = math.asin(max(-1, min(1, math.sin(delta) * math.sin(difference))))
    along = math.atan2(math.sin(delta) * math.cos(difference), math.cos(delta)) * EARTH_KM
    if 0 <= along <= length:
        return min(endpoint_distance, abs(cross) * EARTH_KM)
    return endpoint_distance


def point_url(home: Position, radius_km: float) -> str:
    # A half-cell diagonal is <= 7.87 km globally. Fixed padding does not encode
    # the secret distance from home to the grid point. Radius API units are nm.
    lat = round(home.lat, 1)
    lon = (round(home.lon, 1) + 180) % 360 - 180
    radius_nm = math.ceil((radius_km + 8) / 1.852)
    return f"https://api.adsb.lol/v2/point/{lat:.1f}/{lon:.1f}/{radius_nm}"


@dataclass(frozen=True)
class Settings:
    object_id: str = "demo_sky_airspace"
    unique_id: str = "demo_sky_airspace"
    radius_km: float = 25
    overhead_radius_km: float = 3
    poll_seconds: int = 60
    routes: bool = True

    def __post_init__(self) -> None:
        if not SAFE_ID.fullmatch(self.object_id) or not SAFE_ID.fullmatch(self.unique_id):
            raise Failure("invalid_sensor_id")
        if number(self.radius_km, 1, 100) is None:
            raise Failure("invalid_radius")
        if number(self.overhead_radius_km, 0.1, self.radius_km) is None:
            raise Failure("invalid_overhead_radius")
        if number(self.poll_seconds, 60, 120) is None:
            raise Failure("invalid_poll_interval")


@dataclass
class Response:
    status: int
    data: Any = None
    headers: dict[str, str] = field(default_factory=dict)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


class Http:
    def __init__(self):
        # Ignore environment proxies: never route the HA bearer token to them.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method: str, url: str, *, headers=None, body=None, timeout=12) -> Response:
        data = None if body is None else json.dumps(body, allow_nan=False).encode("utf-8")
        request_headers = {"Accept": "application/json", "User-Agent": "Agraharam-Airspace/1"}
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        request_headers.update(headers or {})
        try:
            request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
            with self.opener.open(request, timeout=timeout) as response:
                content = response.read(MAX_RESPONSE_BYTES + 1)
                if len(content) > MAX_RESPONSE_BYTES:
                    raise Failure("response_too_large")
                try:
                    parsed = json.loads(content) if content else None
                except (ValueError, UnicodeError):
                    raise Failure("invalid_json") from None
                return Response(response.status, parsed, dict(response.headers.items()))
        except urllib.error.HTTPError as error:
            # Do not read, return, log or stringify error body/request/headers.
            response = Response(error.code, headers={"Retry-After": error.headers.get("Retry-After", "")})
            error.close()
            return response
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError):
            raise Failure("transport_error") from None


def retry_after(response: Response, now: float) -> float:
    raw = next((v for k, v in response.headers.items() if k.lower() == "retry-after"), "")
    try:
        seconds = float(raw)
        if math.isfinite(seconds):
            return max(0, seconds)
    except (TypeError, ValueError, OverflowError):
        pass
    try:
        return max(0, parsedate_to_datetime(raw).timestamp() - now)
    except (TypeError, ValueError, OverflowError, AttributeError):
        return 0


def require_ok(response: Response, now: float) -> Any:
    if response.status != 200:
        raise Failure("http_error", retry_after=retry_after(response, now))
    return response.data


class Clock:
    now = staticmethod(time.time)
    monotonic = staticmethod(time.monotonic)


class Backoff:
    def __init__(self, clock, base=60):
        self.clock = clock
        self.base = base
        self.failures = 0
        self.until = 0.0

    def ready(self) -> bool:
        return self.clock.monotonic() >= self.until

    def success(self) -> None:
        self.failures = 0
        self.until = 0

    def fail(self, error: Failure) -> None:
        self.failures = min(self.failures + 1, 16)
        delay = max(min(self.base * 2 ** (self.failures - 1), 3600), error.retry_after)
        self.until = self.clock.monotonic() + delay


def normalize_feed(payload: Any, home: Position, settings: Settings, now: float) -> tuple[float, list[dict]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("ac"), list) or len(payload["ac"]) > 10_000:
        raise Failure("malformed_feed")
    if payload.get("msg") not in (None, "No error"):
        raise Failure("provider_error")
    timestamp = number(payload.get("now"), 0, 1e15)
    if timestamp is None:
        raise Failure("malformed_feed")
    if timestamp > 1e11:
        timestamp /= 1000
    if now - timestamp > POSITION_MAX_AGE or timestamp - now > FUTURE_TOLERANCE:
        raise Failure("stale_feed")
    unique: dict[str, dict] = {}
    structurally_valid = 0
    for raw in payload["ac"]:
        if not isinstance(raw, dict):
            continue
        hex_id = raw.get("hex")
        if not isinstance(hex_id, str) or not HEX.fullmatch(hex_id.lower()):
            continue
        if raw.get("alt_baro") == "ground" or raw.get("ground") is True or raw.get("on_ground") is True:
            structurally_valid += 1
            continue
        try:
            location = Position.parse(raw.get("lat"), raw.get("lon"))
        except Failure:
            continue
        age = number(raw.get("seen_pos"), 0, 1e9)
        if age is None:
            continue
        structurally_valid += 1
        if age > POSITION_MAX_AGE or now - timestamp + age > POSITION_MAX_AGE:
            continue
        distance, bearing = geometry(home, location)
        if distance > settings.radius_km:
            continue
        record = {
            "hex": hex_id.lower(),
            "distance_km": round(distance, 3),
            "bearing_deg": round(bearing, 2) % 360,
            "overhead": distance <= settings.overhead_radius_km,
            "last_seen": iso(timestamp - age),
        }
        for key, source, pattern in (
            ("callsign", "flight", CALLSIGN),
            ("registration", "r", re.compile(r"[A-Z0-9-]{2,16}\Z")),
            ("aircraft_type", "t", re.compile(r"[A-Z0-9]{2,8}\Z")),
        ):
            value = identifier(raw.get(source), pattern)
            if value:
                record[key] = value
        for key, source, low, high in (
            ("altitude_ft", "alt_baro", -2000, 100000),
            ("speed_kts", "gs", 0, 2000),
            ("track_deg", "track", 0, 360),
            ("vertical_rate_fpm", "baro_rate", -20000, 20000),
        ):
            value = number(raw.get(source), low, high)
            if value is not None:
                record[key] = value % 360 if key == "track_deg" else value
        previous = unique.get(record["hex"])
        if previous is None or record["last_seen"] > previous["last_seen"]:
            unique[record["hex"]] = record
    if payload["ac"] and structurally_valid == 0:
        raise Failure("malformed_feed")
    return timestamp, sorted(unique.values(), key=lambda x: (x["distance_km"], x["hex"]))[:MAX_AIRCRAFT]


@dataclass
class Route:
    fields: dict
    airports: list[Position] = field(repr=False)

    def plausible(self, aircraft: dict, home: Position) -> bool:
        point = destination(home, aircraft["distance_km"], aircraft["bearing_deg"])
        return any(segment_distance(point, start, end) <= 100 for start, end in zip(self.airports, self.airports[1:]))


def parse_route(payload: Any, callsign: str) -> Route | None:
    if not isinstance(payload, dict) or payload.get("callsign") != callsign:
        return None
    raw_airports = payload.get("_airports")
    if not isinstance(raw_airports, list) or not 2 <= len(raw_airports) <= 8:
        return None
    airports = []
    codes = []
    icaos = []
    for airport in raw_airports:
        if not isinstance(airport, dict):
            return None
        icao = identifier(airport.get("icao"), re.compile(r"[A-Z0-9]{4}\Z"))
        iata = identifier(airport.get("iata"), re.compile(r"[A-Z]{3}\Z"))
        if icao is None:
            return None
        try:
            airports.append(Position.parse(airport.get("lat"), airport.get("lon")))
        except Failure:
            return None
        icaos.append(icao)
        codes.append(iata or icao)
    if payload.get("airport_codes") != "-".join(icaos):
        return None
    fields = {"origin": codes[0], "destination": codes[-1], "source": "VRS via ADSB.lol", "status": "reported"}
    for key, raw in (("origin_name", raw_airports[0].get("name")), ("destination_name", raw_airports[-1].get("name"))):
        value = label(raw)
        if value:
            fields[key] = value
    # Do not pretend an airline ICAO code is the airline's display name.
    fields["flight_number"] = callsign
    return Route(fields, airports)


class Routes:
    def __init__(self, http, clock, *, capacity=256, positive_ttl=3600, negative_ttl=900):
        self.http, self.clock = http, clock
        self.capacity = capacity
        self.positive_ttl, self.negative_ttl = positive_ttl, negative_ttl
        self.cache: OrderedDict[str, tuple[float, Route | None]] = OrderedDict()
        self.backoff = Backoff(clock)

    def enrich(self, aircraft: list[dict], home: Position) -> None:
        now = self.clock.monotonic()
        for key in list(self.cache):
            if self.cache[key][0] <= now:
                del self.cache[key]
        budget = 2
        for item in aircraft:
            callsign = item.get("callsign")
            if not isinstance(callsign, str) or not CALLSIGN.fullmatch(callsign):
                continue
            if callsign not in self.cache:
                if budget == 0 or not self.backoff.ready():
                    continue
                budget -= 1
                url = f"https://vrs-standing-data.adsb.lol/routes/{callsign[:2]}/{callsign}.json"
                try:
                    response = self.http.request("GET", url, timeout=5)
                    route = None if response.status == 404 else parse_route(require_ok(response, self.clock.now()), callsign)
                    self.backoff.success()
                except Failure as error:
                    self.backoff.fail(error)
                    continue
                ttl = self.positive_ttl if route else self.negative_ttl
                self.cache[callsign] = (self.clock.monotonic() + ttl, route)
                while len(self.cache) > self.capacity:
                    self.cache.popitem(last=False)
            if callsign in self.cache:
                self.cache.move_to_end(callsign)
                route = self.cache[callsign][1]
                if route and route.plausible(item, home):
                    item["route"] = dict(route.fields)


class History:
    def __init__(self):
        self.records: dict[str, dict] = {}
        self.samples: dict[str, list[tuple[float, float]]] = {}

    def update(self, aircraft: list[dict], now: float) -> list[dict]:
        self.records = {k: v for k, v in self.records.items() if 0 <= now - epoch(v["last_seen"]) <= HISTORY_SECONDS}
        self.samples = {
            key: [(seen, distance) for seen, distance in samples if 0 <= now - seen <= HISTORY_SECONDS]
            for key, samples in self.samples.items() if key in self.records
        }
        for item in aircraft:
            if not item["overhead"]:
                continue
            record = dict(item)
            samples = self.samples.setdefault(item["hex"], [])
            observed = (epoch(item["last_seen"]), item["distance_km"])
            if not samples or samples[-1][0] != observed[0]:
                samples.append(observed)
            # At least 60 seconds between polls: 64 covers the entire window,
            # including clock tolerance, while keeping memory strictly bounded.
            self.samples[item["hex"]] = samples[-64:]
            self.records[item["hex"]] = record
        for key, record in self.records.items():
            record["closest_distance_km"] = min(distance for _, distance in self.samples[key])
        newest = sorted(self.records.values(), key=lambda v: (v["last_seen"], v["hex"]), reverse=True)
        self.records = {item["hex"]: item for item in newest[:MAX_HISTORY_TRACKS]}
        self.samples = {key: self.samples[key] for key in self.records}
        return [dict(item) for item in newest[:MAX_RECENT]]


class HomeAssistant:
    def __init__(self, url: str, token: str, http, clock):
        try:
            parsed = urllib.parse.urlsplit(url)
            valid = parsed.scheme in ("http", "https") and parsed.hostname and parsed.port != 0
            valid = valid and not (parsed.username or parsed.password or parsed.query or parsed.fragment)
            valid = valid and parsed.path in ("", "/") and not any(c.isspace() for c in url)
        except (ValueError, TypeError):
            valid = False
        if not valid or not token or any(not c.isprintable() or c.isspace() for c in token):
            raise Failure("invalid_ha_configuration")
        self._url, self._token = url.rstrip("/"), token
        self.http, self.clock = http, clock

    def _request(self, method: str, path: str, body=None):
        response = self.http.request(method, self._url + path, headers={"Authorization": "Bearer " + self._token}, body=body)
        if response.status in (401, 403):
            raise Failure("ha_auth_error")
        return require_ok(response, self.clock.now())

    def home(self) -> Position:
        config = self._request("GET", "/api/config")
        if not isinstance(config, dict):
            raise Failure("invalid_home_configuration")
        try:
            return Position.parse(config.get("latitude"), config.get("longitude"))
        except Failure:
            raise Failure("invalid_home_configuration") from None

    def publish(self, topic: str, payload: str, *, retain: bool):
        # These are the ONLY mutation paths, scoped to this collector's topics.
        self._request("POST", "/api/services/mqtt/publish", {"topic": topic, "payload": payload, "qos": 1, "retain": retain})


class Publisher:
    def __init__(self, ha: HomeAssistant, settings: Settings, clock):
        self.ha, self.settings, self.clock = ha, settings, clock
        self.root = f"agraharam/airspace/{settings.object_id}"
        self.config_topic = f"homeassistant/sensor/{settings.unique_id}/config"
        self.last_discovery: float | None = None

    def _publish(self, topic: str, value: Any, *, retain=False):
        allowed = {self.config_topic, self.root + "/state", self.root + "/availability"}
        if topic not in allowed:
            raise Failure("invalid_topic")
        payload = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(payload.encode("utf-8")) > MAX_STATE_BYTES:
            raise Failure("state_too_large")
        self.ha.publish(topic, payload, retain=retain)

    def discover(self):
        now = self.clock.monotonic()
        if self.last_discovery is not None and now - self.last_discovery < 600:
            return
        self._publish(self.config_topic, {
            "name": "Sky airspace",
            "unique_id": self.settings.unique_id,
            "default_entity_id": "sensor." + self.settings.object_id,
            "state_topic": self.root + "/state",
            "value_template": "{{ value_json.count }}",
            "json_attributes_topic": self.root + "/state",
            "json_attributes_template": "{{ value_json.attributes | tojson }}",
            "availability_topic": self.root + "/availability",
            "payload_available": "online",
            "payload_not_available": "offline",
            "expire_after": EXPIRY_SECONDS,
            "icon": "mdi:airplane",
            "unit_of_measurement": "aircraft",
            "qos": 1,
        }, retain=True)
        self.last_discovery = now

    def publish(self, attributes: dict):
        now = self.clock.now()
        age = now - epoch(attributes["updated_at"])
        if age > POSITION_MAX_AGE or age < -FUTURE_TOLERANCE:
            raise Failure("stale_feed")
        self._publish(self.root + "/state", {"count": len(attributes["aircraft"]), "attributes": attributes})
        self._publish(self.root + "/availability", "online")

    def offline(self):
        self._publish(self.root + "/availability", "offline")

    def remove(self):
        self.offline()
        self._publish(self.config_topic, "", retain=True)


class Collector:
    def __init__(self, ha: HomeAssistant, http, settings: Settings, clock=None):
        self.clock = clock or Clock()
        self.ha, self.http, self.settings = ha, http, settings
        self.home: Position | None = None
        self.home_checked = 0.0
        self.routes = Routes(http, self.clock)
        self.history = History()
        self.provider_backoff = Backoff(self.clock)
        self.last_snapshot: float | None = None

    def collect(self) -> dict:
        if not self.provider_backoff.ready():
            raise Failure("provider_backoff")
        try:
            if self.home is None or self.clock.monotonic() - self.home_checked >= 3600:
                new_home = self.ha.home()
                if self.home != new_home:
                    self.history = History()
                self.home = new_home
                self.home_checked = self.clock.monotonic()
            response = self.http.request("GET", point_url(self.home, self.settings.radius_km))
            payload = require_ok(response, self.clock.now())
            snapshot_time, aircraft = normalize_feed(payload, self.home, self.settings, self.clock.now())
            if self.last_snapshot is not None and snapshot_time <= self.last_snapshot:
                raise Failure("repeated_feed")
            if self.settings.routes:
                self.routes.enrich(aircraft, self.home)
            # Slow enrichment cannot make old observations freshly live.
            now = self.clock.now()
            if now - snapshot_time > POSITION_MAX_AGE or snapshot_time - now > FUTURE_TOLERANCE:
                raise Failure("stale_feed")
            aircraft = [v for v in aircraft if -FUTURE_TOLERANCE <= now - epoch(v["last_seen"]) <= POSITION_MAX_AGE]
            attributes = {
                "schema_version": 1, "provider": "ADSB.lol", "attribution": ATTRIBUTION,
                "updated_at": iso(snapshot_time), "radius_km": self.settings.radius_km,
                "overhead_radius_km": self.settings.overhead_radius_km,
                "aircraft": aircraft, "recent": self.history.update(aircraft, now),
            }
            self.last_snapshot = snapshot_time
            self.provider_backoff.success()
            return attributes
        except Failure as error:
            self.provider_backoff.fail(error)
            raise


class Runner:
    def __init__(self, collector: Collector, publisher: Publisher, *, dry_run=False):
        self.collector, self.publisher, self.dry_run = collector, publisher, dry_run
        self.last_attributes: dict | None = None
        self.publish_backoff = Backoff(collector.clock)

    def cycle(self) -> dict:
        self.last_attributes = None
        if not self.dry_run and not self.publish_backoff.ready():
            return {"status": "offline", "reason": "publish_backoff"}
        try:
            if not self.dry_run:
                self.publisher.discover()
            attributes = self.collector.collect()
            if not self.dry_run:
                self.publisher.publish(attributes)
            self.publish_backoff.success()
            self.last_attributes = attributes
            return {"status": "dry_run" if self.dry_run else "online", "nearby": len(attributes["aircraft"]),
                    "overhead": sum(v["overhead"] for v in attributes["aircraft"]), "recent": len(attributes["recent"]),
                    "reported_routes": sum("route" in v for v in attributes["aircraft"])}
        except Failure as error:
            if not self.dry_run:
                try:
                    self.publisher.offline()
                except Failure as publish_error:
                    self.publish_backoff.fail(publish_error)
                    if publish_error.code == "ha_auth_error":
                        error = publish_error
                # Respect a Retry-After even when the offline marker succeeded.
                if error.retry_after:
                    self.publish_backoff.fail(error)
            return {"status": "offline", "reason": error.code}


def private_output(path: str, attributes: dict):
    """Explicit opt-in proof artifact, exclusively created with owner-only mode."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(attributes, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.write("\n")
    except OSError:
        raise Failure("private_output_failed") from None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit.")
    parser.add_argument("--dry-run", action="store_true", help="Only read; never publish discovery/state/availability.")
    parser.add_argument("--output", help="With --once, create a NEW private 0600 JSON proof file; never use a public path.")
    parser.add_argument("--remove-discovery", action="store_true", help="Stop worker first; remove only its retained discovery entry.")
    parser.add_argument("--object-id", default="demo_sky_airspace")
    parser.add_argument("--unique-id", default=None)
    parser.add_argument("--radius-km", type=float, default=25)
    parser.add_argument("--overhead-radius-km", type=float, default=3)
    parser.add_argument("--poll-seconds", type=int, default=60)
    parser.add_argument("--no-routes", action="store_true")
    args = parser.parse_args(argv)
    if (args.output and (not args.once or args.remove_discovery)) or (args.remove_discovery and args.dry_run):
        print(json.dumps({"status": "error", "reason": "invalid_option_combination"}))
        return 2
    try:
        settings = Settings(args.object_id, args.unique_id or args.object_id, args.radius_km, args.overhead_radius_km, args.poll_seconds, not args.no_routes)
        clock, http = Clock(), Http()
        ha = HomeAssistant(os.environ.get("HA_URL", ""), os.environ.get("HA_TOKEN", ""), http, clock)
        publisher = Publisher(ha, settings, clock)
        if args.remove_discovery:
            publisher.remove()
            print(json.dumps({"status": "removed"}))
            return 0
        runner = Runner(Collector(ha, http, settings, clock), publisher, dry_run=args.dry_run)
        stop = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        auth_failed = False
        try:
            while not stop.is_set():
                result = runner.cycle()
                if args.output and runner.last_attributes is not None:
                    private_output(args.output, runner.last_attributes)
                print(json.dumps(result), flush=True)
                if result.get("reason") == "ha_auth_error":
                    auth_failed = True
                    return 1
                if args.once:
                    return 0 if result["status"] in ("online", "dry_run") else 1
                stop.wait(settings.poll_seconds)
        finally:
            # One-shot live publishing deliberately remains online until expiry.
            if not args.once and not args.dry_run and not auth_failed:
                try:
                    publisher.offline()
                except Failure:
                    pass
        return 0
    except Failure as error:
        print(json.dumps({"status": "error", "reason": error.code}))
        return 1
    except Exception:
        # Unexpected local errors must not dump HA URL/token or provider payloads.
        print(json.dumps({"status": "error", "reason": "internal_error"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
