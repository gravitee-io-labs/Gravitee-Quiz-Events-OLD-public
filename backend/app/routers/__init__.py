"""
API routers. Mounting (see app/main.py):

  health          no prefix            GET /health, GET /api/health
  auth            /api/auth            login, logout, me
  public_events   /api/events          GET "", GET /{slug}, POST /{slug}/players
  games           /api/events          POST /{slug}/games, POST /{slug}/games/{game_id}/submit
  scoreboard      /api/events          GET /{slug}/scoreboard, GET /{slug}/scoreboard/stream
  admin_events    /api/admin           /events..., (create with ``admin_router()``)
  admin_categories/api/admin           /events/{id}/categories, /categories/{cid}
  admin_questions /api/admin           /events/{id}/questions..., /questions/{qid}
  admin_results   /api/admin           /events/{id}/results..., /results/{sid}

Routes are declared RELATIVE to the mount prefix. Admin routers are mounted by main.py with
``dependencies=[Depends(require_admin)]`` (and should be created with ``app.auth.admin_router()``).
"""
