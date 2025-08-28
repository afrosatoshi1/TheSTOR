require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');

const app = express();
const DB_FILE = path.join(__dirname, 'data', 'neotech.sqlite');
const dbDir = path.dirname(DB_FILE);
if (!require('fs').existsSync(dbDir)) require('fs').mkdirSync(dbDir, {recursive:true});
const db = new sqlite3.Database(DB_FILE);

// Basic middleware
app.set('view engine','ejs');
app.use(express.urlencoded({extended:true}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: './data' }),
  secret: process.env.SESSION_SECRET || 'dev_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*24 } // 1 day
}));

// Simple helper to run SQL with Promise
function run(sql, params=[]){ return new Promise((res,rej)=> db.run(sql, params, function(err){ if(err) rej(err); else res(this); })); }
function get(sql, params=[]){ return new Promise((res,rej)=> db.get(sql, params, (err,row)=> err?rej(err):res(row))); }
function all(sql, params=[]){ return new Promise((res,rej)=> db.all(sql, params, (err,rows)=> err?rej(err):res(rows))); }

// Initialize tables if missing (basic)
db.serialize(()=>{
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'customer', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price INTEGER NOT NULL, category_id INTEGER, description TEXT DEFAULT '', image TEXT DEFAULT '', active INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, total INTEGER NOT NULL, status TEXT DEFAULT 'PENDING', reference TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, product_id INTEGER, qty INTEGER, price INTEGER
  )`);
});

// Middleware: load user
app.use(async (req,res,next)=>{
  res.locals.user = null;
  if (req.session.userId){
    try{
      const u = await get('SELECT id,email,role FROM users WHERE id=?',[req.session.userId]);
      res.locals.user = u || null;
    }catch(e){ res.locals.user = null; }
  }
  next();
});

// Routes - Simple pages
app.get('/', async (req,res)=>{
  const products = await all('SELECT * FROM products WHERE active=1 ORDER BY id DESC LIMIT 30');
  res.render('index',{products});
});

app.get('/product/:id', async (req,res)=>{
  const id = req.params.id;
  const product = await get('SELECT * FROM products WHERE id=?',[id]);
  if(!product) return res.status(404).render('404');
  const recs = await all('SELECT * FROM products WHERE id!=? AND active=1 LIMIT 4',[id]);
  res.render('product',{product,recs});
});

app.get('/category/:id', async (req,res)=>{
  const id = req.params.id;
  const category = await get('SELECT * FROM categories WHERE id=?',[id]);
  if(!category) return res.status(404).render('404');
  const products = await all('SELECT * FROM products WHERE category_id=? AND active=1',[id]);
  res.render('category',{category,products});
});

// AUTH
app.get('/login',(req,res)=>res.render('login',{error:null}));
app.post('/login', async (req,res)=>{
  const {email,password} = req.body;
  if(!email||!password) return res.render('login',{error:'Missing fields'});
  try{
    const user = await get('SELECT * FROM users WHERE email=?',[email]);
    if(!user) return res.render('login',{error:'Invalid credentials'});
    const ok = await bcrypt.compare(password, user.password);
    if(!ok) return res.render('login',{error:'Invalid credentials'});
    req.session.userId = user.id;
    return res.redirect('/');
  }catch(e){ return res.render('login',{error:'Server error'}); }
});

app.get('/register',(req,res)=>res.render('register',{error:null}));
app.post('/register', async (req,res)=>{
  const {email,password} = req.body;
  if(!email||!password) return res.render('register',{error:'Missing fields'});
  try{
    const hash = await bcrypt.hash(password,10);
    await run('INSERT INTO users (email,password) VALUES (?,?)',[email,hash]);
    return res.redirect('/login');
  }catch(e){
    return res.render('register',{error:'Email already in use'});
  }
});

app.post('/logout',(req,res)=>{
  req.session.destroy(()=> res.redirect('/'));
});

// CART (simple session cart)
app.post('/cart/add', async (req,res)=>{
  const pid = Number(req.body.product_id);
  const qty = Math.max(1, Number(req.body.qty||1));
  const product = await get('SELECT id,name,price,image FROM products WHERE id=?',[pid]);
  if(!product) return res.redirect('/');
  req.session.cart = req.session.cart || [];
  const existing = req.session.cart.find(i=>i.product_id===pid);
  if(existing){ existing.qty += qty; } else { req.session.cart.push({ product_id: pid, name: product.name, price: product.price, qty, image: product.image }); }
  return res.redirect('/cart');
});

app.get('/cart', (req,res)=>{
  const cart = req.session.cart || [];
  const total = cart.reduce((s,i)=>s + (i.price * i.qty), 0);
  res.render('cart',{cart,total});
});

app.post('/cart/update', (req,res)=>{
  const {id,qty} = req.body;
  if(!req.session.cart) return res.redirect('/cart');
  const idx = req.session.cart.findIndex(i=>String(i.product_id)===String(id));
  if(idx===-1) return res.redirect('/cart');
  const q = Math.max(1, Number(qty||1));
  req.session.cart[idx].qty = q;
  res.redirect('/cart');
});

app.get('/cart/clear',(req,res)=>{ req.session.cart = []; res.redirect('/cart'); });

// CHECKOUT - show checkout page
app.get('/checkout', (req,res)=>{
  const cart = req.session.cart || [];
  if(!cart.length) return res.redirect('/cart');
  const total = cart.reduce((s,i)=>s + (i.price * i.qty), 0);
  res.render('checkout',{cart,total,paystackKey:process.env.PAYSTACK_PUBLIC_KEY || ''});
});

// PAYSTACK VERIFY endpoint
app.get('/checkout/verify', async (req,res)=>{
  const reference = req.query.reference;
  if(!reference) return res.redirect('/checkout');
  try{
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if(!secret) throw new Error('Paystack secret not set');
    const {data} = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,{
      headers:{ Authorization: 'Bearer ' + secret }
    });
    if(data && data.status && data.data && data.data.status === 'success'){
      // create order if user exists; else create guest order
      const cart = req.session.cart || [];
      const total = cart.reduce((s,i)=>s + (i.price * i.qty), 0);
      const userId = req.session.userId || null;
      const r = await run('INSERT INTO orders (user_id,total,status,reference) VALUES (?,?,?,?)',[userId,total,'PAID',reference]);
      const orderId = r.lastID;
      const stmt = db.prepare('INSERT INTO order_items (order_id,product_id,qty,price) VALUES (?,?,?,?)');
      for(const it of cart){ stmt.run(orderId, it.product_id, it.qty, it.price); }
      stmt.finalize();
      req.session.cart = [];
      return res.render('payment',{ok:true,ref:reference});
    } else {
      return res.render('payment',{ok:false});
    }
  }catch(e){
    console.error(e);
    return res.render('payment',{ok:false});
  }
});

// ADMIN - minimal protected dashboard
function requireAdmin(req,res,next){
  if(!req.session.userId) return res.redirect('/login');
  db.get('SELECT role FROM users WHERE id=?',[req.session.userId],(err,row)=>{
    if(err||!row||row.role!=='admin') return res.status(403).send('Forbidden');
    next();
  });
}

app.get('/admin', requireAdmin, async (req,res)=>{
  const products = await all('SELECT * FROM products');
  const categories = await all('SELECT * FROM categories');
  const orders = await all('SELECT * FROM orders ORDER BY id DESC LIMIT 30');
  res.render('admin',{products,categories,orders});
});

app.post('/admin/products/create', requireAdmin, async (req,res)=>{
  const {name,price,category_id,image,description} = req.body;
  await run('INSERT INTO products (name,price,category_id,image,description) VALUES (?,?,?,?,?)',[name,price||0,category_id||null,image||'',description||'']);
  res.redirect('/admin');
});
app.post('/admin/products/update/:id', requireAdmin, async (req,res)=>{
  const id = req.params.id;
  const {name,price,category_id,image,description,active} = req.body;
  await run('UPDATE products SET name=?,price=?,category_id=?,image=?,description=?,active=? WHERE id=?',[name,price||0,category_id||null,image||'',description||'', active?1:0, id]);
  res.redirect('/admin');
});
app.get('/admin/products/delete/:id', requireAdmin, async (req,res)=>{
  await run('DELETE FROM products WHERE id=?',[req.params.id]);
  res.redirect('/admin');
});

// simple categories CRUD
app.post('/admin/categories/create', requireAdmin, async (req,res)=>{
  await run('INSERT INTO categories (name) VALUES (?)',[req.body.name]);
  res.redirect('/admin');
});
app.post('/admin/categories/update/:id', requireAdmin, async (req,res)=>{
  await run('UPDATE categories SET name=? WHERE id=?',[req.body.name, req.params.id]);
  res.redirect('/admin');
});
app.get('/admin/categories/delete/:id', requireAdmin, async (req,res)=>{
  await run('DELETE FROM categories WHERE id=?',[req.params.id]);
  res.redirect('/admin');
});

// orders status update
app.post('/admin/orders/status/:id', requireAdmin, async (req,res)=>{
  await run('UPDATE orders SET status=? WHERE id=?',[req.body.status, req.params.id]);
  res.redirect('/admin');
});

// Catch-all 404
app.use((req,res)=> res.status(404).render('404'));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('NeoTech MVP running on port', PORT));
