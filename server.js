const express=require("express");
const path=require("path");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const Database=require("better-sqlite3");

const app=express();
const db=new Database("data.db");
const PORT=process.env.PORT||3000;
const SECRET=process.env.JWT_SECRET||"dev-only-change-me";

app.use(express.json());
app.use(express.static(path.join(__dirname,"public")));

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user',
 balance INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'active',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS devices(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 code TEXT UNIQUE NOT NULL,
 status TEXT NOT NULL DEFAULT 'available',
 price_per_day INTEGER NOT NULL DEFAULT 5000,
 owner_user_id INTEGER,
 expires_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rentals(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 device_id INTEGER NOT NULL,
 started_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS transactions(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 type TEXT NOT NULL,
 amount INTEGER NOT NULL,
 description TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER,
 action TEXT NOT NULL,
 metadata TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

if(!db.prepare("SELECT id FROM users WHERE email=?").get("admin@example.com")){
  db.prepare("INSERT INTO users(name,email,password_hash,role,balance) VALUES(?,?,?,?,?)")
    .run("Administrator","admin@example.com",bcrypt.hashSync("change-this-password",12),"admin",100000);
}
if(db.prepare("SELECT COUNT(*) c FROM devices").get().c===0){
  const s=db.prepare("INSERT INTO devices(name,code,price_per_day) VALUES(?,?,?)");
  [["Device Alpha","WA-001",5000],["Device Beta","WA-002",7500],["Device Gamma","WA-003",10000],["Device Delta","WA-004",12500]].forEach(x=>s.run(...x));
}

function audit(uid,action,meta={}) {
  db.prepare("INSERT INTO audit_logs(user_id,action,metadata) VALUES(?,?,?)")
    .run(uid||null,action,JSON.stringify(meta));
}
function auth(req,res,next){
  try{
    const t=(req.headers.authorization||"").replace("Bearer ","");
    req.user=jwt.verify(t,SECRET); next();
  }catch{res.status(401).json({error:"Sesi tidak valid"})}
}
function syncExpired(){
  const now=new Date().toISOString();
  const rows=db.prepare("SELECT * FROM rentals WHERE status='active' AND expires_at<=?").all(now);
  const tx=db.transaction(()=>{
    for(const r of rows){
      db.prepare("UPDATE rentals SET status='expired' WHERE id=?").run(r.id);
      db.prepare("UPDATE devices SET status='available',owner_user_id=NULL,expires_at=NULL WHERE id=?").run(r.device_id);
      audit(r.user_id,"rental_expired",{rentalId:r.id,deviceId:r.device_id});
    }
  });
  if(rows.length) tx();
}
setInterval(syncExpired,15000);
syncExpired();

app.post("/api/auth/register",(req,res)=>{
  const {name,email,password}=req.body;
  if(!name||!email||!password||password.length<8)
    return res.status(400).json({error:"Data tidak lengkap atau password kurang dari 8 karakter"});
  try{
    const id=db.prepare("INSERT INTO users(name,email,password_hash) VALUES(?,?,?)")
      .run(name,email.trim().toLowerCase(),bcrypt.hashSync(password,12)).lastInsertRowid;
    audit(id,"register");
    res.json({ok:true});
  }catch{res.status(409).json({error:"Email sudah terdaftar"})}
});

app.post("/api/auth/login",(req,res)=>{
  const u=db.prepare("SELECT * FROM users WHERE email=?").get((req.body.email||"").trim().toLowerCase());
  if(!u||u.status!=="active"||!bcrypt.compareSync(req.body.password||"",u.password_hash))
    return res.status(401).json({error:"Email atau password salah"});
  const token=jwt.sign({id:u.id,role:u.role},SECRET,{expiresIn:"12h"});
  audit(u.id,"login");
  res.json({token,user:{id:u.id,name:u.name,email:u.email,role:u.role,balance:u.balance}});
});

app.get("/api/dashboard",auth,(req,res)=>{
  syncExpired();
  const u=db.prepare("SELECT id,name,email,role,balance FROM users WHERE id=?").get(req.user.id);
  const devices=db.prepare("SELECT id,name,code,status,price_per_day,expires_at FROM devices ORDER BY id").all();
  const rentals=db.prepare(`
    SELECT r.id,r.started_at,r.expires_at,r.status,d.name,d.code
    FROM rentals r JOIN devices d ON d.id=r.device_id
    WHERE r.user_id=? ORDER BY r.id DESC`).all(req.user.id);
  const stats={
    totalDevices:devices.length,
    available:devices.filter(d=>d.status==="available").length,
    rented:devices.filter(d=>d.status==="rented").length,
    myActive:rentals.filter(r=>r.status==="active").length
  };
  res.json({user:u,devices,rentals,stats});
});

app.post("/api/rentals",auth,(req,res)=>{
  syncExpired();
  const device=db.prepare("SELECT * FROM devices WHERE id=?").get(Number(req.body.deviceId));
  const days=Number(req.body.days);
  if(!device)return res.status(404).json({error:"Perangkat tidak ditemukan"});
  if(device.status!=="available")return res.status(409).json({error:"Perangkat sedang disewa"});
  if(!Number.isInteger(days)||days<1||days>30)return res.status(400).json({error:"Durasi 1-30 hari"});
  const u=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  const cost=device.price_per_day*days;
  if(u.balance<cost)return res.status(402).json({error:"Saldo tidak cukup"});
  const start=new Date(),expires=new Date(start.getTime()+days*86400000).toISOString();
  const id=db.transaction(()=>{
    db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(cost,u.id);
    db.prepare("UPDATE devices SET status='rented',owner_user_id=?,expires_at=? WHERE id=?").run(u.id,expires,device.id);
    const rid=db.prepare("INSERT INTO rentals(user_id,device_id,started_at,expires_at) VALUES(?,?,?,?)").run(u.id,start.toISOString(),expires).lastInsertRowid;
    db.prepare("INSERT INTO transactions(user_id,type,amount,description) VALUES(?,?,?,?)").run(u.id,"rental",-cost,`Rental #${rid}`);
    audit(u.id,"rental_created",{rentalId:rid,deviceId:device.id,days,cost});
    return rid;
  })();
  res.json({ok:true,rentalId:id});
});

app.get("/api/admin/overview",auth,(req,res)=>{
  if(req.user.role!=="admin")return res.status(403).json({error:"Forbidden"});
  syncExpired();
  const users=db.prepare("SELECT COUNT(*) c FROM users WHERE role='user'").get().c;
  const devices=db.prepare("SELECT COUNT(*) c FROM devices").get().c;
  const active=db.prepare("SELECT COUNT(*) c FROM rentals WHERE status='active'").get().c;
  const revenue=Math.abs(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='rental'").get().s);
  const logs=db.prepare("SELECT action,metadata,created_at FROM audit_logs ORDER BY id DESC LIMIT 12").all();
  res.json({users,devices,active,revenue,logs});
});

app.post("/api/admin/topup",auth,(req,res)=>{
  if(req.user.role!=="admin")return res.status(403).json({error:"Forbidden"});
  const uid=Number(req.body.userId),amount=Number(req.body.amount);
  if(!Number.isInteger(uid)||!Number.isInteger(amount)||amount<1000)return res.status(400).json({error:"Top up tidak valid"});
  db.transaction(()=>{
    db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(amount,uid);
    db.prepare("INSERT INTO transactions(user_id,type,amount,description) VALUES(?,?,?,?)").run(uid,"topup",amount,"Admin top up");
    audit(req.user.id,"admin_topup",{userId:uid,amount});
  })();
  res.json({ok:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`WA Rental Pro running on http://localhost:${PORT}`));
