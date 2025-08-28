const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'data', 'neotech.sqlite');
if (!fs.existsSync(path.dirname(dbPath))) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new sqlite3.Database(dbPath);

db.serialize(()=> {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'customer',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    category_id INTEGER,
    description TEXT DEFAULT '',
    image TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    total INTEGER NOT NULL,
    status TEXT DEFAULT 'PENDING',
    reference TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    product_id INTEGER,
    qty INTEGER,
    price INTEGER
  )`);

  // seed admin if missing
  const adminEmail = 'admin@neotech.local';
  db.get('SELECT * FROM users WHERE email=?', [adminEmail], (e,row)=>{
    if(!row){
      const hash = bcrypt.hashSync('admin123', 10);
      db.run('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', [adminEmail, hash, 'admin']);
      console.log('Admin user created:', adminEmail, '/ admin123');
    }
  });

  // seed categories idempotent
  const cats = ['Phones & Tablets','Computers','Audio','Gaming','Wearables'];
  cats.forEach((c)=>{
    db.get('SELECT id FROM categories WHERE name=?',[c], (er,r)=>{
      if(!r) db.run('INSERT INTO categories (name) VALUES (?)',[c]);
    });
  });

  // seed products if none exist
  db.get('SELECT COUNT(*) as cnt FROM products', [], (err, row)=>{
    if(row && row.cnt === 0){
      const prods = [
        ['NeoPhone X1', 250000, 1, '6.7” AMOLED, 5G, 128GB', '/img/phone.png'],
        ['Tab Pro 11', 310000, 1, '11” IPS, 8GB/256GB', '/img/tablet.png'],
        ['UltraBook 14', 890000, 2, 'Core i7, 16GB/512GB SSD', '/img/laptop.png'],
        ['BassPods Wireless', 68000, 3, 'ANC earbuds, 24h battery', '/img/earbuds.png'],
        ['GameBox One S', 420000, 4, '4K HDR console', '/img/console.png'],
        ['NeoWatch S', 95000, 5, 'AMOLED, GPS, SpO2', '/img/watch.png']
      ];
      prods.forEach(p => db.run('INSERT INTO products (name, price, category_id, description, image) VALUES (?,?,?,?,?)', p));
      console.log('Seeded products');
    }
  });
});

db.close();
