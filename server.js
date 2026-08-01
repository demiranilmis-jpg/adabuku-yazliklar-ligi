require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL ortam degiskeni eksik.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET ortam degiskeni eksik.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  name: 'adabuku.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProd, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));

const q = (text, params = []) => pool.query(text, params);
const escInt = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const adminOnly = (req, res, next) => req.session.admin ? next() : res.redirect('/admin/login');

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    league_name TEXT NOT NULL DEFAULT 'Adabükü Yazlıklar Ligi',
    season TEXT NOT NULL DEFAULT '2026 Yaz Sezonu',
    primary_color TEXT NOT NULL DEFAULT '#0b5d7a',
    secondary_color TEXT NOT NULL DEFAULT '#f4b942',
    logo_url TEXT DEFAULT '',
    announcement TEXT DEFAULT 'Adabükü Yazlıklar Ligi resmi internet sitesine hoş geldiniz.'
  )`);
  await q(`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await q(`CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    short_name TEXT NOT NULL DEFAULT '',
    logo_url TEXT DEFAULT '',
    color TEXT DEFAULT '#0b5d7a',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    jersey_no INTEGER,
    position TEXT NOT NULL DEFAULT 'Oyuncu',
    photo_url TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS matches (
    id SERIAL PRIMARY KEY,
    week INTEGER NOT NULL DEFAULT 1,
    match_date TIMESTAMPTZ,
    venue TEXT DEFAULT '',
    home_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    away_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    home_score INTEGER,
    away_score INTEGER,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','played','postponed')),
    notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (home_team_id <> away_team_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS player_stats (
    id SERIAL PRIMARY KEY,
    match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    goals INTEGER NOT NULL DEFAULT 0,
    assists INTEGER NOT NULL DEFAULT 0,
    saves INTEGER NOT NULL DEFAULT 0,
    yellow_cards INTEGER NOT NULL DEFAULT 0,
    red_cards INTEGER NOT NULL DEFAULT 0,
    UNIQUE(match_id, player_id)
  )`);
}

async function getSettings() {
  const { rows } = await q('SELECT * FROM settings WHERE id=1');
  return rows[0];
}

async function standings() {
  const { rows } = await q(`
    SELECT t.id, t.name, t.short_name, t.logo_url,
      COUNT(m.id) FILTER (WHERE m.status='played')::int AS played,
      COUNT(m.id) FILTER (WHERE m.status='played' AND ((m.home_team_id=t.id AND m.home_score>m.away_score) OR (m.away_team_id=t.id AND m.away_score>m.home_score)))::int AS won,
      COUNT(m.id) FILTER (WHERE m.status='played' AND m.home_score=m.away_score)::int AS drawn,
      COUNT(m.id) FILTER (WHERE m.status='played' AND ((m.home_team_id=t.id AND m.home_score<m.away_score) OR (m.away_team_id=t.id AND m.away_score<m.home_score)))::int AS lost,
      COALESCE(SUM(CASE WHEN m.status='played' AND m.home_team_id=t.id THEN m.home_score WHEN m.status='played' AND m.away_team_id=t.id THEN m.away_score ELSE 0 END),0)::int AS gf,
      COALESCE(SUM(CASE WHEN m.status='played' AND m.home_team_id=t.id THEN m.away_score WHEN m.status='played' AND m.away_team_id=t.id THEN m.home_score ELSE 0 END),0)::int AS ga,
      (COUNT(m.id) FILTER (WHERE m.status='played' AND ((m.home_team_id=t.id AND m.home_score>m.away_score) OR (m.away_team_id=t.id AND m.away_score>m.home_score)))*3 +
       COUNT(m.id) FILTER (WHERE m.status='played' AND m.home_score=m.away_score))::int AS points
    FROM teams t
    LEFT JOIN matches m ON (m.home_team_id=t.id OR m.away_team_id=t.id)
    GROUP BY t.id
    ORDER BY points DESC, (COALESCE(SUM(CASE WHEN m.status='played' AND m.home_team_id=t.id THEN m.home_score WHEN m.status='played' AND m.away_team_id=t.id THEN m.away_score ELSE 0 END),0)-COALESCE(SUM(CASE WHEN m.status='played' AND m.home_team_id=t.id THEN m.away_score WHEN m.status='played' AND m.away_team_id=t.id THEN m.home_score ELSE 0 END),0)) DESC, gf DESC, t.name
  `);
  return rows.map(r => ({ ...r, gd: r.gf - r.ga }));
}

async function leaders(column, limit = 10) {
  const allowed = ['goals','assists','saves','yellow_cards','red_cards'];
  if (!allowed.includes(column)) throw new Error('Geçersiz istatistik');
  const { rows } = await q(`SELECT p.id, p.name, p.photo_url, p.position, t.name team_name, t.logo_url,
    COALESCE(SUM(ps.${column}),0)::int value
    FROM players p JOIN teams t ON t.id=p.team_id
    LEFT JOIN player_stats ps ON ps.player_id=p.id
    GROUP BY p.id,t.id HAVING COALESCE(SUM(ps.${column}),0)>0
    ORDER BY value DESC,p.name LIMIT $1`, [limit]);
  return rows;
}

app.use(async (req, res, next) => {
  try {
    res.locals.settings = await getSettings();
    res.locals.isAdmin = Boolean(req.session.admin);
    res.locals.path = req.path;
    next();
  } catch (e) { next(e); }
});

app.get('/', async (req, res, next) => {
  try {
    const [table, fixtures, results, goals, assists, saves] = await Promise.all([
      standings(),
      q(`SELECT m.*, h.name home_name,h.logo_url home_logo,a.name away_name,a.logo_url away_logo FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id WHERE m.status<>'played' ORDER BY m.match_date NULLS LAST,m.week LIMIT 8`).then(x=>x.rows),
      q(`SELECT m.*, h.name home_name,h.logo_url home_logo,a.name away_name,a.logo_url away_logo FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id WHERE m.status='played' ORDER BY m.match_date DESC NULLS LAST,m.id DESC LIMIT 8`).then(x=>x.rows),
      leaders('goals',5), leaders('assists',5), leaders('saves',5)
    ]);
    res.render('index', { title:'Ana Sayfa', table, fixtures, results, goals, assists, saves });
  } catch(e){ next(e); }
});

app.get('/puan-durumu', async (req,res,next)=>{ try{ res.render('standings',{title:'Puan Durumu',table:await standings()}); }catch(e){next(e);} });
app.get('/fikstur', async (req,res,next)=>{ try{ const {rows}=await q(`SELECT m.*,h.name home_name,h.logo_url home_logo,a.name away_name,a.logo_url away_logo FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id ORDER BY m.week,m.match_date NULLS LAST,m.id`); res.render('fixtures',{title:'Fikstür ve Sonuçlar',matches:rows}); }catch(e){next(e);} });
app.get('/istatistikler', async (req,res,next)=>{ try{ res.render('stats',{title:'İstatistikler',goals:await leaders('goals',50),assists:await leaders('assists',50),saves:await leaders('saves',50),yellows:await leaders('yellow_cards',50),reds:await leaders('red_cards',50)}); }catch(e){next(e);} });
app.get('/takimlar', async(req,res,next)=>{ try{ const {rows}=await q(`SELECT t.*,COUNT(p.id)::int player_count FROM teams t LEFT JOIN players p ON p.team_id=t.id GROUP BY t.id ORDER BY t.name`); res.render('teams',{title:'Takımlar',teams:rows}); }catch(e){next(e);} });
app.get('/takim/:id', async(req,res,next)=>{ try{ const team=(await q('SELECT * FROM teams WHERE id=$1',[req.params.id])).rows[0]; if(!team)return res.status(404).render('error',{title:'Bulunamadı',message:'Takım bulunamadı.'}); const players=(await q(`SELECT p.*,COALESCE(SUM(ps.goals),0)::int goals,COALESCE(SUM(ps.assists),0)::int assists,COALESCE(SUM(ps.saves),0)::int saves FROM players p LEFT JOIN player_stats ps ON ps.player_id=p.id WHERE p.team_id=$1 GROUP BY p.id ORDER BY p.jersey_no NULLS LAST,p.name`,[team.id])).rows; res.render('team',{title:team.name,team,players}); }catch(e){next(e);} });

app.get('/admin/login',(req,res)=>res.render('admin-login',{title:'Yönetici Girişi',error:null}));
app.post('/admin/login', async(req,res)=>{
  const user=String(req.body.username||''); const pass=String(req.body.password||'');
  const validUser=user===String(process.env.ADMIN_USERNAME||'admin');
  const envPass=String(process.env.ADMIN_PASSWORD||'');
  const validPass=envPass.startsWith('$2') ? await bcrypt.compare(pass,envPass) : pass===envPass;
  if(validUser&&validPass){req.session.admin=true;return res.redirect('/admin');}
  res.status(401).render('admin-login',{title:'Yönetici Girişi',error:'Kullanıcı adı veya şifre hatalı.'});
});
app.post('/admin/logout',(req,res)=>req.session.destroy(()=>res.redirect('/')));

app.get('/admin',adminOnly,async(req,res,next)=>{try{ const [teams,players,matches]=await Promise.all([q('SELECT COUNT(*)::int c FROM teams'),q('SELECT COUNT(*)::int c FROM players'),q('SELECT COUNT(*)::int c FROM matches')]);res.render('admin',{title:'Yönetim Paneli',counts:{teams:teams.rows[0].c,players:players.rows[0].c,matches:matches.rows[0].c}});}catch(e){next(e);}});
app.get('/admin/settings',adminOnly,(req,res)=>res.render('admin-settings',{title:'Lig Ayarları'}));
app.post('/admin/settings',adminOnly,async(req,res,next)=>{try{await q(`UPDATE settings SET league_name=$1,season=$2,primary_color=$3,secondary_color=$4,logo_url=$5,announcement=$6 WHERE id=1`,[req.body.league_name,req.body.season,req.body.primary_color,req.body.secondary_color,req.body.logo_url,req.body.announcement]);res.redirect('/admin/settings');}catch(e){next(e);}});

app.get('/admin/teams',adminOnly,async(req,res,next)=>{try{res.render('admin-teams',{title:'Takımları Yönet',teams:(await q('SELECT * FROM teams ORDER BY name')).rows});}catch(e){next(e);}});
app.post('/admin/teams',adminOnly,async(req,res,next)=>{try{await q('INSERT INTO teams(name,short_name,logo_url,color) VALUES($1,$2,$3,$4)',[req.body.name,req.body.short_name||'',req.body.logo_url||'',req.body.color||'#0b5d7a']);res.redirect('/admin/teams');}catch(e){next(e);}});
app.post('/admin/teams/:id/delete',adminOnly,async(req,res,next)=>{try{await q('DELETE FROM teams WHERE id=$1',[req.params.id]);res.redirect('/admin/teams');}catch(e){next(e);}});

app.get('/admin/players',adminOnly,async(req,res,next)=>{try{const [players,teams]=await Promise.all([q(`SELECT p.*,t.name team_name FROM players p JOIN teams t ON t.id=p.team_id ORDER BY t.name,p.name`),q('SELECT * FROM teams ORDER BY name')]);res.render('admin-players',{title:'Oyuncuları Yönet',players:players.rows,teams:teams.rows});}catch(e){next(e);}});
app.post('/admin/players',adminOnly,async(req,res,next)=>{try{await q('INSERT INTO players(team_id,name,jersey_no,position,photo_url) VALUES($1,$2,$3,$4,$5)',[req.body.team_id,req.body.name,req.body.jersey_no||null,req.body.position||'Oyuncu',req.body.photo_url||'']);res.redirect('/admin/players');}catch(e){next(e);}});
app.post('/admin/players/:id/delete',adminOnly,async(req,res,next)=>{try{await q('DELETE FROM players WHERE id=$1',[req.params.id]);res.redirect('/admin/players');}catch(e){next(e);}});

app.get('/admin/matches',adminOnly,async(req,res,next)=>{try{const [matches,teams]=await Promise.all([q(`SELECT m.*,h.name home_name,a.name away_name FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id ORDER BY m.week,m.match_date NULLS LAST`),q('SELECT * FROM teams ORDER BY name')]);res.render('admin-matches',{title:'Fikstürü Yönet',matches:matches.rows,teams:teams.rows});}catch(e){next(e);}});
app.post('/admin/matches',adminOnly,async(req,res,next)=>{try{await q(`INSERT INTO matches(week,match_date,venue,home_team_id,away_team_id,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7)`,[escInt(req.body.week,1),req.body.match_date||null,req.body.venue||'',req.body.home_team_id,req.body.away_team_id,req.body.status||'scheduled',req.body.notes||'']);res.redirect('/admin/matches');}catch(e){next(e);}});
app.post('/admin/matches/:id/result',adminOnly,async(req,res,next)=>{try{await q(`UPDATE matches SET home_score=$1,away_score=$2,status='played' WHERE id=$3`,[escInt(req.body.home_score),escInt(req.body.away_score),req.params.id]);res.redirect('/admin/matches');}catch(e){next(e);}});
app.post('/admin/matches/:id/delete',adminOnly,async(req,res,next)=>{try{await q('DELETE FROM matches WHERE id=$1',[req.params.id]);res.redirect('/admin/matches');}catch(e){next(e);}});

app.get('/admin/stats',adminOnly,async(req,res,next)=>{try{const [players,matches,stats]=await Promise.all([q(`SELECT p.id,p.name,t.name team_name FROM players p JOIN teams t ON t.id=p.team_id ORDER BY t.name,p.name`),q(`SELECT m.id,m.week,h.name home_name,a.name away_name FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id ORDER BY m.id DESC`),q(`SELECT ps.*,p.name player_name,h.name home_name,a.name away_name FROM player_stats ps JOIN players p ON p.id=ps.player_id LEFT JOIN matches m ON m.id=ps.match_id LEFT JOIN teams h ON h.id=m.home_team_id LEFT JOIN teams a ON a.id=m.away_team_id ORDER BY ps.id DESC LIMIT 100`)]);res.render('admin-stats',{title:'Oyuncu İstatistikleri',players:players.rows,matches:matches.rows,stats:stats.rows});}catch(e){next(e);}});
app.post('/admin/stats',adminOnly,async(req,res,next)=>{try{await q(`INSERT INTO player_stats(match_id,player_id,goals,assists,saves,yellow_cards,red_cards) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(match_id,player_id) DO UPDATE SET goals=EXCLUDED.goals,assists=EXCLUDED.assists,saves=EXCLUDED.saves,yellow_cards=EXCLUDED.yellow_cards,red_cards=EXCLUDED.red_cards`,[req.body.match_id||null,req.body.player_id,escInt(req.body.goals),escInt(req.body.assists),escInt(req.body.saves),escInt(req.body.yellow_cards),escInt(req.body.red_cards)]);res.redirect('/admin/stats');}catch(e){next(e);}});

app.get('/health',(req,res)=>res.json({ok:true,time:new Date().toISOString()}));
app.use((req,res)=>res.status(404).render('error',{title:'Sayfa Bulunamadı',message:'Aradığınız sayfa bulunamadı.'}));
app.use((err,req,res,next)=>{console.error(err);res.status(500).render('error',{title:'Bir hata oluştu',message:isProd?'İşlem sırasında bir hata oluştu. Lütfen tekrar deneyin.':err.message});});

initDb().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`Adabuku Ligi http://localhost:${PORT}`))).catch(err=>{console.error('Veritabani baslatma hatasi:',err);process.exit(1);});
