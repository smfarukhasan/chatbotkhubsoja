.PHONY: backend-run frontend-build migrate docker-up docker-down

backend-run:
	cd backend_js && npm run dev

frontend-build:
	cd frontend && npm run build

migrate:
	cd backend_js && npx prisma db push

docker-up:
	docker compose up --build

docker-down:
	docker compose down
