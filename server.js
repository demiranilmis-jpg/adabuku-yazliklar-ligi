import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL eksik. .env dosyasını oluşturun.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : undefined
});

await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PgStore = pgSession(session);
app.set('trust proxy', 1);
app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'degistir-beni',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProd, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));

const q = (text, params=[]) => pool.query(text, params);
const toInt = (v, fallback=0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const requireAdmin = (req,res,next) => req.session.admin ? next() : res.redirect('/admin/login');

app.use(async (req,res,next) => {
  try {
    const { rows } = await q('SELECT * FROM settings WHERE id=1');
    res.locals.settings = rows[0];
    res.locals.isAdmin = !!req.session.admin;
    next();
  } catch (e) { next(e); }
});

async function standings() {
  const { rows } = await q(`
    SELECT t.id, t.name, t.short_name, t.logo_url,
      COUNT(m.id) FILTER (WHERE m.status='played')::int AS played,
      COUNT(m.id) FILTER (WHERE m.status='played' AND ((m.home_team_id=t.id AND m.home_score>m.away_score) OR (m.away_team_id=t.id AND m.away_score>m.home_score)))::int AS won,
      COUNT(m.id) FILTER (WHERE m.status='played' AND m.home_score=m.away_score)::int AS drawn,
      COUNT(m.id) FILTER (WHERE m.status='played' AND ((m.home_team_id=t.id AND m.home_score<m.away_score) OR (m.away_team_id=t.id AND m.away_score<m.home_score)))::int AS lost,
      COALESCE(SUM(CASE WHEN m.status='played' AND m.home_team_id=t.id THEN m.home_score WHEN m.status='played' AND m.away_team_id=t.id THEN m.away_score ELSE 0 END),0)::int AS gf,
      COALESCE(SUM(CASE WHEN m.status='played' AND m.home_team_id=t.id THEN m.away_score WHEN m.status='played' AND m.away_team_id=t.id THEN m.home_score ELSE 0 END),0)::int AS ga,
      COALESCE(SUM(CASE WHEN m.status='played' AND ((m.home_team_id=t.id AND m.home_score>m.away_score) OR (m.away_team_id=t.id AND m.away_score>m.home_score)) THEN 3 WHEN m.status='played' AND m.home_score=m.away_score THEN 1 ELSE 0 END),0)::int AS points
    FROM teams t
    LEFT JOIN matches m ON (m.home_team_id=t.id OR m.away_team_id=t.id)
    GROUP BY t.id
    ORDER BY points DESC, (COALESCE(SUM(CASE WHEN m.status='played' AND m.home_team_id=t.id THEN m.home_score-m.away_score WHEN m.status='played' AND m.away_team_id=t.id THEN m.away_score-m.home_score ELSE 0 END),0)) DESC, gf DESC, t.name
  `);
  return rows.map(r => ({...r, gd: r.gf-r.ga}));
}

async function leaders(column) {
  const allowed = ['goals','assists','saves'];
  if (!allowed.includes(column)) throw new Error('Geçersiz istatistik');
  const { rows } = await q(`SELECT p.id, p.name, p.position, t.name team_name, t.logo_url, COALESCE(SUM(ps.${column}),0)::int total
    FROM players p JOIN teams t ON t.id=p.team_id LEFT JOIN player_stats ps ON ps.player_id=p.id
    GROUP BY p.id,t.id HAVING COALESCE(SUM(ps.${column}),0)>0 ORDER BY total DESC,p.name LIMIT 20`);
  return rows;
}

app.get('/', async (req,res,next) => { try {
  const table = await standings();
  const { rows: matches } = await q(`SELECT m.*, h.name home_name, a.name away_name FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id ORDER BY COALESCE(m.match_date, NOW()+INTERVAL '100 years'), m.week LIMIT 8`);
  res.render('index',{table,matches});
} catch(e){next(e)} });

app.get('/fikstur', async (req,res,next) => { try {
  const { rows } = await q(`SELECT m.*, h.name home_name, h.logo_url home_logo, a.name away_name, a.logo_url away_logo FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id ORDER BY m.week, m.match_date NULLS LAST, m.id`);
  res.render('fixtures',{matches:rows});
} catch(e){next(e)} });
app.get('/puan-durumu', async (req,res,next) => { try { res.render('standings',{table:await standings()}); } catch(e){next(e)} });
app.get('/istatistikler', async (req,res,next) => { try { res.render('stats',{goals:await leaders('goals'),assists:await leaders('assists'),saves:await leaders('saves')}); } catch(e){next(e)} });
app.get('/takimlar', async (req,res,next) => { try { const {rows}=await q(`SELECT t.*, COUNT(p.id)::int player_count FROM teams t LEFT JOIN players p ON p.team_id=t.id GROUP BY t.id ORDER BY t.name`); res.render('teams',{teams:rows}); } catch(e){next(e)} });

app.get('/admin/login',(req,res)=>res.render('login',{error:null}));
app.post('/admin/login', async (req,res) => {
  const username = String(req.body.username||'');
  const password = String(req.body.password||'');
  const validUser = username === (process.env.ADMIN_USERNAME || 'admin');
  const configured = process.env.ADMIN_PASSWORD || 'ulel1209';
  const validPass = configured.startsWith('$2') ? await bcrypt.compare(password, configured) : password === configured;
  if (!validUser || !validPass) return res.status(401).render('login',{error:'Kullanıcı adı veya şifre yanlış.'});
  req.session.admin=true; res.redirect('/admin');
});
app.post('/admin/logout',(req,res)=>req.session.destroy(()=>res.redirect('/')));

app.get('/admin', requireAdmin, async (req,res,next) => { try {
  const [{rows:teams},{rows:players},{rows:matches},{rows:stats}] = await Promise.all([
    q('SELECT * FROM teams ORDER BY name'),
    q('SELECT p.*,t.name team_name FROM players p JOIN teams t ON t.id=p.team_id ORDER BY t.name,p.name'),
    q(`SELECT m.*,h.name home_name,a.name away_name FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id ORDER BY m.week,m.match_date NULLS LAST`),
    q(`SELECT ps.*,p.name player_name,t.name team_name,COALESCE(m.week,0) week FROM player_stats ps JOIN players p ON p.id=ps.player_id JOIN teams t ON t.id=p.team_id LEFT JOIN matches m ON m.id=ps.match_id ORDER BY ps.id DESC`)
  ]);
  res.render('admin',{teams,players,matches,stats,message:req.query.m||''});
} catch(e){next(e)} });

app.post('/admin/settings', requireAdmin, async (req,res,next)=>{try{
  await q(`UPDATE settings SET league_name=$1,season=$2,primary_color=$3,secondary_color=$4,logo_url=$5,updated_at=NOW() WHERE id=1`,[req.body.league_name,req.body.season,req.body.primary_color,req.body.secondary_color,req.body.logo_url||'']);
  res.redirect('/admin?m=Ayarlar kaydedildi');
}catch(e){next(e)}});
app.post('/admin/teams', requireAdmin, async (req,res,next)=>{try{await q('INSERT INTO teams(name,short_name,logo_url) VALUES($1,$2,$3)',[req.body.name,req.body.short_name||'',req.body.logo_url||'']);res.redirect('/admin?m=Takım eklendi')}catch(e){next(e)}});
app.post('/admin/teams/:id/delete', requireAdmin, async(req,res,next)=>{try{await q('DELETE FROM teams WHERE id=$1',[req.params.id]);res.redirect('/admin?m=Takım silindi')}catch(e){next(e)}});
app.post('/admin/players', requireAdmin, async(req,res,next)=>{try{await q('INSERT INTO players(team_id,name,position,shirt_number) VALUES($1,$2,$3,$4)',[req.body.team_id,req.body.name,req.body.position||'Oyuncu',req.body.shirt_number||null]);res.redirect('/admin?m=Oyuncu eklendi')}catch(e){next(e)}});
app.post('/admin/players/:id/delete', requireAdmin, async(req,res,next)=>{try{await q('DELETE FROM players WHERE id=$1',[req.params.id]);res.redirect('/admin?m=Oyuncu silindi')}catch(e){next(e)}});
app.post('/admin/matches', requireAdmin, async(req,res,next)=>{try{
  const played=req.body.status==='played';
  await q(`INSERT INTO matches(week,match_date,home_team_id,away_team_id,home_score,away_score,venue,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[toInt(req.body.week,1),req.body.match_date||null,req.body.home_team_id,req.body.away_team_id,played?toInt(req.body.home_score,0):null,played?toInt(req.body.away_score,0):null,req.body.venue||'',req.body.status||'scheduled']);
  res.redirect('/admin?m=Maç eklendi');
}catch(e){next(e)}});
app.post('/admin/matches/:id/update', requireAdmin, async(req,res,next)=>{try{
  const played=req.body.status==='played';
  await q(`UPDATE matches SET week=$1,match_date=$2,home_score=$3,away_score=$4,venue=$5,status=$6 WHERE id=$7`,[toInt(req.body.week,1),req.body.match_date||null,played?toInt(req.body.home_score,0):null,played?toInt(req.body.away_score,0):null,req.body.venue||'',req.body.status,req.params.id]);
  res.redirect('/admin?m=Maç güncellendi');
}catch(e){next(e)}});
app.post('/admin/matches/:id/delete', requireAdmin, async(req,res,next)=>{try{await q('DELETE FROM matches WHERE id=$1',[req.params.id]);res.redirect('/admin?m=Maç silindi')}catch(e){next(e)}});
app.post('/admin/stats', requireAdmin, async(req,res,next)=>{try{
  await q(`INSERT INTO player_stats(player_id,match_id,goals,assists,saves,yellow_cards,red_cards) VALUES($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT(player_id,match_id) DO UPDATE SET goals=EXCLUDED.goals,assists=EXCLUDED.assists,saves=EXCLUDED.saves,yellow_cards=EXCLUDED.yellow_cards,red_cards=EXCLUDED.red_cards`,[req.body.player_id,req.body.match_id||null,toInt(req.body.goals),toInt(req.body.assists),toInt(req.body.saves),toInt(req.body.yellow_cards),toInt(req.body.red_cards)]);
  res.redirect('/admin?m=İstatistik kaydedildi');
}catch(e){next(e)}});
app.post('/admin/stats/:id/delete', requireAdmin, async(req,res,next)=>{try{await q('DELETE FROM player_stats WHERE id=$1',[req.params.id]);res.redirect('/admin?m=İstatistik silindi')}catch(e){next(e)}});

app.use((err,req,res,next)=>{console.error(err);res.status(500).send(`Bir hata oluştu: ${isProd?'Lütfen daha sonra tekrar deneyin.':err.message}`)});
app.listen(process.env.PORT||3000,()=>console.log(`http://localhost:${process.env.PORT||3000}`));
