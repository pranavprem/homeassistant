.PHONY: bootstrap up down logs config smoke

bootstrap:
	./scripts/bootstrap.sh

up:
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

config:
	docker compose config

smoke:
	python3 -m compileall services/homebutler/app
	docker compose --env-file example.env config >/dev/null
