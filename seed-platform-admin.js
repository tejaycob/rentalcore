/**
 * Creates the FIRST platform administrator.
 *
 * Chicken-and-egg: platform admins are created by invite, but only a
 * platform admin can issue one. This seeds the first account directly.
 * Run it once, then create everyone else from the console.
 *
 *   DATABASE_URL="postgresql://..." node seed-platform-admin.js you@teja.co.mz 'YourPassword'
 */
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const [, , email, password] = process.argv;

if (!email || !password) {
  console.error('\nUsage: DATABASE_URL="..." node seed-platform-admin.js <email> <password>\n');
  process.exit(1);
}
if (password.length < 10) {
  console.error('\nUse at least 10 characters — this account can see every client.\n');
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows: [existing] } = await pool.query(
      `SELECT id, role FROM users WHERE lower(email) = lower($1)`, [email]);
    if (existing) {
      console.error(`\n${email} already exists (role: ${existing.role}). Nothing changed.\n`);
      process.exit(1);
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (company_id, role, name, email, password_hash, locale)
       VALUES (NULL, 'platform_admin', 'Platform Administrator', $1, $2, 'pt')
       RETURNING id, email, role`,
      [email, hash],
    );

    console.log('\n✅ Platform administrator created\n');
    console.log(`   email: ${user.email}`);
    console.log(`   role:  ${user.role}`);
    console.log('\n   Sign in and you will land on /platform\n');
  } catch (e) {
    console.error('\n❌ Failed:', e.message);
    if (e.detail) console.error('   detail:', e.detail);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
