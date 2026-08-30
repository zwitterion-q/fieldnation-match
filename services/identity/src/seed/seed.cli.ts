/**
 * Seeds roles, permissions and ~30 accounts.
 *
 * Technician and hirer logins are derived from rows that already exist in
 * db-technicians and db-workorders, so every account maps onto real data --
 * logging in as a technician shows that technician's actual matches, not a
 * placeholder.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import { User } from '../users/user.entity';
import { Role } from '../rbac/role.entity';
import { Permission } from '../rbac/permission.entity';
import { ROLE_MATRIX, P } from '../rbac/permissions';

const IDENTITY_DSN = process.env.IDENTITY_DSN || 'postgresql://fn:fn@localhost:55434/identity';
const TECH_DSN     = process.env.TECH_DSN     || 'postgresql://fn:fn@localhost:55433/technicians';
const WO_DSN       = process.env.WO_DSN       || 'postgresql://fn:fn@localhost:55432/workorders';
const PASSWORD     = process.env.SEED_PASSWORD || 'Passw0rd!';

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

async function main() {
  const ds = new DataSource({
    type: 'postgres', url: IDENTITY_DSN,
    entities: [User, Role, Permission], synchronize: true,
  });
  await ds.initialize();
  const permRepo = ds.getRepository(Permission);
  const roleRepo = ds.getRepository(Role);
  const userRepo = ds.getRepository(User);

  // ---- permissions -------------------------------------------------------
  const permMap = new Map<string, Permission>();
  for (const name of Object.values(P)) {
    let p = await permRepo.findOne({ where: { name } });
    if (!p) p = await permRepo.save(permRepo.create({ name }));
    permMap.set(name, p);
  }

  // ---- roles -------------------------------------------------------------
  const roleMap = new Map<string, Role>();
  for (const [roleName, perms] of Object.entries(ROLE_MATRIX)) {
    let r = await roleRepo.findOne({ where: { name: roleName } });
    if (!r) r = roleRepo.create({ name: roleName });
    r.permissions = perms.map(p => permMap.get(p)!);
    r = await roleRepo.save(r);
    roleMap.set(roleName, r);
  }
  console.log(`roles: ${[...roleMap.keys()].join(', ')}`);

  const hash = await bcrypt.hash(PASSWORD, 10);
  const rows: any[] = [];
  const seededEmails = new Set<string>();

  async function upsert(email: string, fullName: string, roles: string[],
                        subjectType?: string, subjectId?: number, company?: string) {
    email = email.toLowerCase();
    let u = await userRepo.findOne({ where: { email } });
    if (!u) u = userRepo.create({ email });
    u.passwordHash = hash; u.fullName = fullName; u.active = true;
    u.subjectType = subjectType ?? null; u.subjectId = subjectId ?? null;
    u.companyName = company ?? null;
    u.roles = roles.map(r => roleMap.get(r)!);
    await userRepo.save(u);
    seededEmails.add(email);
    rows.push({ email, fullName, roles: roles.join('+'), company: company ?? '',
                subject: subjectType ? `${subjectType}#${subjectId}` : '' });
  }

  // ---- platform staff ----------------------------------------------------
  await upsert('admin@fieldnation.test',      'Ada Admin',        ['admin']);
  await upsert('dispatcher@fieldnation.test', 'Dev Dispatcher',   ['dispatcher']);
  await upsert('finance@fieldnation.test',    'Fin Controller',   ['finance']);

  // ---- hirers, from the buyer companies actually present on work orders ---
  const wo = new Client({ connectionString: WO_DSN }); await wo.connect();
  const buyers = (await wo.query(
    `SELECT company, count(*) n FROM work_orders
      WHERE company IS NOT NULL AND source_type='synthetic'
      GROUP BY company ORDER BY n DESC LIMIT 8`)).rows;
  await wo.end();

  for (const b of buyers) {
    const s = slug(b.company);
    await upsert(`hirer@${s}.test`, `${b.company} Dispatch Desk`, ['hirer'],
                 'hirer', null, b.company);
  }
  console.log(`hirers: ${buyers.length}`);

  // ---- technicians, from real profiles ------------------------------------
  const tc = new Client({ connectionString: TECH_DSN }); await tc.connect();
  const techs = (await tc.query(
    `SELECT technician_id, full_name, city, state, rating
       FROM technicians ORDER BY technician_id`)).rows;
  await tc.end();

  for (const t of techs) {
    // Every technician gets an account so any match in the UI is loginable.
    // technician_id is appended because names collide across 60 profiles.
    await upsert(`${slug(t.full_name)}.${t.technician_id}@tech.test`, t.full_name,
                 ['technician'], 'technician', t.technician_id, `${t.city}, ${t.state}`);
  }
  console.log(`technicians: ${techs.length}`);

  // ---- reconcile ----------------------------------------------------------
  // The seeder must be idempotent across schema changes, not just re-runnable.
  // Upserting on email alone leaves orphans behind the moment an email format
  // changes -- which is exactly what happened when technician emails gained an
  // id suffix. Anything subject-linked that this run did not produce is stale.
  const all = await userRepo.find();
  const stale = all.filter(u => u.subjectType && !seededEmails.has(u.email));
  if (stale.length) {
    await userRepo.remove(stale);
    console.log(`removed ${stale.length} stale account(s) from a previous seed`);
  }

  // ---- credentials file ---------------------------------------------------
  const w = (s: string, n: number) => s.padEnd(n);
  const lines = [
    '# Seeded credentials',
    '',
    `Every account uses the same password: \`${PASSWORD}\``,
    '',
    'Technician and hirer accounts map onto rows that already exist in the',
    'technicians and work-orders databases, so logging in as one shows that',
    "subject's real data rather than a placeholder.",
    '',
    '## Platform staff', '',
    '| Email | Name | Roles |', '|---|---|---|',
    ...rows.filter(r => !r.subject).map(r => `| \`${r.email}\` | ${r.fullName} | ${r.roles} |`),
    '',
    '## Hirers', '',
    '| Email | Company |', '|---|---|',
    ...rows.filter(r => r.roles === 'hirer').map(r => `| \`${r.email}\` | ${r.company} |`),
    '',
    '## Technicians', '',
    '| Email | Name | Based | Technician |', '|---|---|---|---|',
    ...rows.filter(r => r.roles === 'technician')
           .map(r => `| \`${r.email}\` | ${r.fullName} | ${r.company} | ${r.subject} |`),
    '',
    '## Role permissions', '',
    ...Object.entries(ROLE_MATRIX).flatMap(([role, perms]) =>
      [`**${role}** — ${perms.length} permissions`, '', '```',
       perms.join('\n'), '```', '']),
  ];
  fs.writeFileSync('/out/CREDENTIALS.md', lines.join('\n'));

  console.log(`\ntotal accounts: ${rows.length}`);
  console.log('credentials written to CREDENTIALS.md');
  await ds.destroy();
}

main().catch(e => { console.error(e); process.exit(1); });
