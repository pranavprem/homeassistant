.PHONY: bootstrap up down logs config smoke sync-trusted-proxies

bootstrap:
	./scripts/bootstrap.sh

up:
	docker compose up --build -d
	python3 ./scripts/sync_trusted_proxies.py --restart-homeassistant

sync-trusted-proxies:
	python3 ./scripts/sync_trusted_proxies.py --restart-homeassistant

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

config:
	docker compose config

smoke:
	python3 -m compileall services/homebutler/app
	python3 -m py_compile scripts/sync_trusted_proxies.py
	docker compose --env-file example.env config >/dev/null
