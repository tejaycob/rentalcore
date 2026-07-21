const { Pool } = require('pg');
const bcrypt = require('bcrypt');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [company] } = await client.query(
      `INSERT INTO companies (name, country_code, currency, plan_tier, trial_ends_at)
       VALUES ('ETM Group', 'MZ', 'MZN', 'starter', now() + interval '30 days')
       RETURNING id, name`
    );

    const hash = await bcrypt.hash('Admin123!', 12);

    const { rows: [user] } = await client.query(
      `INSERT INTO users (company_id, role, name, email, password_hash, locale)
       VALUES ($1, 'owner', 'Super Admin', 'admin@rentalcore.local', $2, 'pt')
       RETURNING email, role`,
      [company.id, hash]
    );

    await client.query('COMMIT');
    console.log('\n✅ SEEDED\n');
    console.log('  company:  ' + company.name + '  (' + company.id + ')');
    console.log('  email:    ' + user.email);
    console.log('  password: Admin123!');
    console.log('  role:     ' + user.role + '\n');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n❌ FAILED — this is the real error:\n');
    console.error('  message: ' + e.message);
    console.error('  detail:  ' + (e.detail || '(none)'));
    console.error('  table:   ' + (e.table || '(none)'));
    console.error('  column:  ' + (e.column || '(none)') + '\n');
  } finally {
    client.release();
    await pool.end();
  }
})();
