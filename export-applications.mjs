import {existsSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const dbPath = join(DATA_DIR, 'applications.sqlite');
if (!existsSync(dbPath)) {
  console.error(`База не найдена: ${dbPath}`);
  process.exit(1);
}
const output = resolve(process.argv[2] || join(ROOT, `applications-${new Date().toISOString().slice(0,10)}.csv`));
const db = new DatabaseSync(dbPath, {readOnly:true});
const rows = db.prepare('SELECT created_at, full_name, phone, email, telegram, company_role, participation FROM applications ORDER BY created_at DESC').all();
const columns = ['Дата','ФИО','Телефон','Email','Telegram','Компания и роль','Участие'];
const keys = ['created_at','full_name','phone','email','telegram','company_role','participation'];
const escape = value => `"${String(value ?? '').replaceAll('"','""')}"`;
const csv = '\uFEFF' + [columns.map(escape).join(';'), ...rows.map(row => keys.map(key => escape(row[key])).join(';'))].join('\r\n');
writeFileSync(output, csv, {encoding:'utf8', mode:0o600});
db.close();
console.log(`Экспортировано анкет: ${rows.length}`);
console.log(`Файл: ${output}`);
