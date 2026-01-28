# CLAUDE.md - AI Assistant Guide for Quiz App

This document provides essential context for AI assistants working with this codebase.

## Project Overview

**Name:** Test Tayyor (Quiz App)
**Purpose:** Online examination platform for teacher-created tests, student registration, exam administration, and automated result tracking.
**Language Context:** UI text in Uzbek ("Test Tayyor" = "Test Ready")

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Backend** | Express.js 5.x (Node.js) |
| **Database** | Supabase PostgreSQL (primary) + JSON files (fallback) |
| **Auth (Teachers)** | Google OAuth 2.0 via Passport.js |
| **Auth (Students)** | Custom password-based with Scrypt hashing |
| **Frontend** | Vanilla JS + Tailwind CSS (CDN) |
| **Sessions** | PostgreSQL store with memory fallback |
| **Deployment** | Fly.io with Docker |
| **File Uploads** | Multer to persistent `/data` directory |

## Project Structure

```
quiz-app/
├── server/                      # Backend
│   ├── server.js                # Main Express app (entry point)
│   ├── parser.js                # Question parsing utilities
│   ├── auth/
│   │   └── passport.js          # Google OAuth configuration
│   └── dak/                     # Exam subsystem
│       ├── routes.js            # All DAK API endpoints
│       ├── store.js             # Data access layer (Supabase + JSON fallback)
│       └── migrations/
│           └── 001_create_dak_tables.sql
│
├── public/                      # Frontend (served statically)
│   ├── index.html               # Landing page
│   ├── dashboard.html           # Teacher control panel
│   ├── dak.html                 # Student exam interface
│   ├── script.js                # General quiz logic
│   ├── dak.js                   # DAK exam client logic
│   └── images/, uploads/, samples/
│
├── data/                        # Persistent storage (JSON fallback)
│   ├── app_settings.json        # App configuration
│   ├── dak_config.json          # Exam parameters
│   ├── dak_banks.json           # Question banks
│   ├── dak_roster.json          # Student roster
│   └── results/                 # Exam results (JSON + XLSX)
│
├── Dockerfile                   # Container configuration
├── fly.toml                     # Fly.io deployment config
└── package.json                 # Dependencies
```

## Key Files Reference

| File | Purpose | Lines |
|------|---------|-------|
| `server/server.js` | Express app, middleware, session management, static serving | ~1300 |
| `server/dak/routes.js` | All DAK API endpoints (exam management) | ~1175 |
| `server/dak/store.js` | Data access layer with Supabase/JSON dual storage | ~500 |
| `server/auth/passport.js` | Google OAuth strategy configuration | ~80 |
| `public/dak.js` | Student exam interface logic | ~600 |
| `public/script.js` | Teacher dashboard and quiz creation | ~550 |

## Database Schema (Supabase)

### Tables

**`dak_banks`** - Question banks
```sql
- bank_id: TEXT (UNIQUE)
- subject_name: TEXT
- questions: JSONB (array of question objects)
```

**`dak_roster`** - Student roster
```sql
- roster_data: JSONB (hierarchical: university > program > group > students)
- updated_by: TEXT (teacher email)
```

**`dak_accounts`** - Student credentials
```sql
- login: TEXT (UNIQUE, format: "GROUP-001")
- password_hash: TEXT (Scrypt)
- salt: TEXT
- full_name, university, program, group, exam_date: TEXT
- active: BOOLEAN
```

**`dak_attempts`** - Exam attempts
```sql
- student_fullname, university, program_name, group_name: TEXT
- started_at, finished_at: TIMESTAMP
- questions: JSONB (with shuffled options)
- answers: JSONB (student responses)
- correct_count, score_points: INTEGER
```

## API Routes Overview

### Teacher Routes (require Google OAuth)
```
GET  /api/user                          # Get teacher info
GET  /api/teacher/dak/roster            # Get student roster
POST /api/teacher/dak/roster            # Upload roster
POST /api/teacher/dak/upload-bank       # Upload question bank
GET  /api/teacher/dak/banks             # List question banks
DELETE /api/teacher/dak/banks/:id       # Delete bank
GET  /api/teacher/dak/config            # Get exam config
POST /api/teacher/dak/config            # Update exam config
POST /api/teacher/dak/credentials/generate  # Generate student logins
GET  /api/teacher/dak/exports           # Export results (XLSX)
POST /api/teacher/exam-mode             # Toggle exam mode
```

### Student Routes (public with password auth)
```
POST /api/public/dak/auth/login         # Student login
GET  /api/public/dak/auth/me            # Get current student
POST /api/public/dak/auth/logout        # Student logout
GET  /api/public/dak/programs           # List programs
GET  /api/public/dak/groups             # List groups for program
POST /api/public/dak/start              # Start exam attempt
GET  /api/public/dak/attempt/:id/questions  # Get exam questions
POST /api/public/dak/attempt/:id/answer # Save answer
POST /api/public/dak/attempt/:id/finish # Complete exam
```

## Environment Variables

### Required for Production
```bash
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...        # Or SUPABASE_KEY
SUPABASE_DB_URL=postgresql://...        # Or DATABASE_URL
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx
SESSION_SECRET=random-secure-string
NODE_ENV=production
```

### Optional
```bash
BASE_URL=https://testtayyor.fly.dev     # Defaults based on platform
TEACHER_EMAIL=xxx@gmail.com             # Allowed teacher email
PORT=3000                               # Server port
PG_MAX=20                               # Connection pool size
```

## Development Setup

```bash
# Install dependencies
npm install

# Set environment variables (optional for local dev - uses JSON files)
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...

# Start server
node server/server.js

# Access at http://localhost:3000
```

Without Supabase credentials, the app automatically uses local JSON files in `/data/`.

## Coding Conventions

### JavaScript Style
- ES6+ syntax with async/await
- No TypeScript (pure JavaScript)
- Comments in Uzbek language throughout codebase
- Single quotes for strings (mixed with double in some files)

### Error Handling Pattern
```javascript
try {
    const result = await supabaseOperation();
    return result;
} catch (err) {
    console.error('Operation Supabase error:', err.message);
    // Fallback to local JSON file
    return fallbackToLocalFile();
}
```

### Data Access Pattern (store.js)
All data operations use a dual-storage pattern:
1. Try Supabase first (production)
2. Fall back to local JSON files (development/failure)

### Password Hashing
- Algorithm: Scrypt
- Parameters: N=16384, r=8, p=1, keylen=64
- Salt: 16 random bytes

### Session Configuration
- TTL: 7 days (web), 6 hours (exam)
- Store: PostgreSQL primary, memory fallback
- Cookies: httpOnly, secure in production

## Rate Limiting
- API: 100 requests/minute per IP
- Login: 10 attempts/15 minutes per IP

## Question File Format

Questions are uploaded as `.txt` files:
```
1. Question text goes here?
a) Option A
*b) Correct answer (marked with asterisk)
c) Option C
d) Option D

2. Next question?
a) Option
*b) Correct
c) Option
d) Option
```

## Deployment

### Fly.io (Current)
```bash
# Deploy (automatic from git push to main)
fly deploy

# View logs
fly logs

# SSH into machine
fly ssh console
```

### Configuration (fly.toml)
- Region: Hong Kong (hkg)
- Memory: 2GB
- Persistent storage: `/data` (50GB volume)
- HTTPS enforced

## Common Tasks for AI Assistants

### Adding a New API Endpoint
1. Add route in `server/dak/routes.js`
2. Add data access method in `server/dak/store.js` if needed
3. Handle both Supabase and JSON fallback

### Modifying Frontend
1. Edit HTML in `public/*.html`
2. Edit JS in `public/*.js`
3. Tailwind CSS via CDN (no build step)

### Database Changes
1. Create SQL migration in `server/dak/migrations/`
2. Update store.js methods
3. Update migration guide if schema changes

### Testing Locally
```bash
# No formal test framework - use manual testing
node server/server.js
# Teacher: /dashboard (requires Google OAuth)
# Student: /dak (uses generated credentials)
```

## Important Files NOT to Commit

From `.gitignore`:
- `.env`, `.env.local` (secrets)
- `data/dak_accounts.json` (credentials)
- `data/dak_sessions.json` (sessions)
- `data/dak_attempts/` (attempt data)
- `server/dak/test-*.js` (test scripts)
- `server/dak/debug-*.js` (debug scripts)

## Troubleshooting

### "Supabase error: relation does not exist"
Run SQL migration: `server/dak/migrations/001_create_dak_tables.sql`

### Local development not connecting to Supabase
Normal behavior - uses JSON files as fallback when SUPABASE_URL is not set

### Session issues
Check PostgreSQL connection; falls back to memory store automatically

## Related Documentation

- [DAK_MIGRATION_GUIDE.md](./DAK_MIGRATION_GUIDE.md) - Detailed Supabase migration guide
- [Fly.io Configuration](https://fly.io/docs/reference/configuration/) - Deployment docs
