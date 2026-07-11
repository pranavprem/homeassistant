.PHONY: bootstrap up down logs config smoke sync-trusted-proxies apply-grocy-migration patch-eight-sleep-alarm-switch

bootstrap:
	./scripts/bootstrap.sh

up:
	docker compose up --build -d
	python3 ./scripts/sync_trusted_proxies.py --restart-homeassistant

sync-trusted-proxies:
	python3 ./scripts/sync_trusted_proxies.py --restart-homeassistant

apply-grocy-migration:
	python3 ./scripts/apply_grocy_migration.py

patch-eight-sleep-alarm-switch:
	python3 ./scripts/patch_eight_sleep_alarm_switch.py --restart-homeassistant

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

config:
	docker compose config

smoke:
	python3 -m compileall services/homebutler/app
	python3 -m py_compile scripts/sync_trusted_proxies.py
	python3 -m py_compile scripts/apply_grocy_migration.py
	python3 -m py_compile scripts/patch_eight_sleep_alarm_switch.py
	docker compose --env-file example.env config >/dev/null
