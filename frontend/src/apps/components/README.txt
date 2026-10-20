INDEX COMPONENTS  (drop-in folder)

1. Copy this whole "components" folder to:  src/apps/components   (replace the old one)
2. Registry entry (src/apps/registry.ts), only if you do not have it yet:
     {
       id: 'index-components',
       name: 'Index Components',
       path: '/index-components',
       icon: '\u25e8',
       component: lazy(() => import('./components/ComponentsApp')),
     },
3. Backend: needs GET /api/quotes and GET /api/history (backend.zip). Default address http://127.0.0.1:8000,
   change with VITE_API_BASE in a .env file.
4. Previous close = last daily candle dated before today (IST), fetched once per stock per day through the backend
   and cached in localStorage as prevClose.<IST date>. Old days are deleted automatically.
5. The page uses its own styles (components.css) and follows data-theme="dark".
6. Old files you can delete if present: config/securityIds.json and scripts/build-security-ids.mjs.
7. Tests: npm test  (logic/prevClose.test.ts, logic/components.test.ts)
