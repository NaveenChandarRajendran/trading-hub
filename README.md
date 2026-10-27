# Trading Hub

Indian index options (NIFTY, BANKNIFTY) trading platform: OI tools, paper trading, Power Scalper, the OI breakout algo.
Paper trading only: no code path places real orders.

## Start

    cd frontend && npm install && npm run build      (once, and after UI changes)
    cd backend  && pip install -r requirements.txt
    python main.py                                    (in backend/; DATABASE_URL + Dhan keys in backend/.env.local)

Open **http://127.0.0.1:8000** and log in. First user (there is no sign-up page), in `backend/`:

    python scripts/create_user.py --username naveen --name "Naveen"

Development: run the backend as above and `npm run dev` in `frontend/` → http://localhost:5173 (Vite forwards
`/api` and `/ws` to the backend). Opening `frontend/dist/index.html` by double-click only shows how to start.

More: `backend/README.md`, `CLAUDE.md`, `docs/02-current-state.md`, `docs/users-and-strategies.md`.
