"""
auth_api.py - login / logout / who am I (auth.py does the work):
    POST /api/auth/login   {"username", "password"} -> {"user": {...}} + session cookie; 401 wrong, 429 too many tries
    POST /api/auth/logout  -> {"ok": true}, deletes the session and clears the cookie
    GET  /api/auth/me      -> {"user": {...}} (401 without a session, from AuthMiddleware)
"""
from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from auth import LoginRefused, cookie_header


class LoginBody(BaseModel):
    username: str = ""
    password: str = ""


def current_user(request):
    """The signed-in user (AuthMiddleware put it there; every non-public route has one)."""
    return request.state.user


def register(app, auth):
    @app.post("/api/auth/login")
    def login(body: LoginBody, request: Request):
        ip = request.client.host if request.client else ""
        try:
            user, token = auth.login(body.username, body.password, ip, request.headers.get("user-agent", ""))
        except LoginRefused as e:
            headers = {"Retry-After": str(e.retry_after)} if e.retry_after else None
            return JSONResponse({"detail": e.message}, status_code=e.status, headers=headers)
        res = JSONResponse({"user": user.public()})
        res.headers.append("set-cookie", cookie_header(token, request.url.scheme == "https"))
        res.headers["cache-control"] = "no-store"
        return res

    @app.post("/api/auth/logout")
    def logout(request: Request):
        auth.logout(request.state.session_token)
        res = JSONResponse({"ok": True})
        res.headers.append("set-cookie", cookie_header("", request.url.scheme == "https", max_age=0))
        return res

    @app.get("/api/auth/me")
    def me(request: Request):
        return {"user": current_user(request).public()}
