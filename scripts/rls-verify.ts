/* npm run test:rls — no RLS policy recursion: every public table / view queried as anon, a dealer user and
   a super admin (scripts/sql/rls-recursion-verify.sql, rolled back). --with-migration prepends 189. */
import { loadScriptEnv } from "./crm-env";
import { runSqlTest } from "./sql-test";

loadScriptEnv();
runSqlTest("scripts/sql/rls-recursion-verify.sql", "RLS_TEST",
  process.argv.includes("--with-migration") ? ["supabase/migrations/189_profiles_rls_no_recursion.sql"] : [])
  .then((ok) => process.exit(ok ? 0 : 1), (e) => { console.error(e); process.exit(1); });
