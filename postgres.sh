docker run --name adaptive-agent-postgres \
  -e POSTGRES_USER=adaptive \
  -e POSTGRES_PASSWORD=asdf1234 \
  -e POSTGRES_DB=adaptive_agent \
  -p 5432:5432 \
  -d postgres:17


