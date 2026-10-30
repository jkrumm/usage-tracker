# Test database: the mini's maintained Postgres, admin role (the tests create and drop usage_test_<random>
# databases). Resolved by secrets-run in `make check` / `make test`.
USAGE_TEST_PG_USER=op://vps/config/POSTGRES_USER
USAGE_TEST_PG_PASSWORD=op://mini/vps-dev/POSTGRES_PASSWORD
