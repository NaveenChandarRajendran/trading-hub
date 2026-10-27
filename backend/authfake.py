"""authfake.py - for tests that aren't about login: create_app with every request already signed in as one user.
Login itself, sessions, the failed-login limit and the 401 / 4401 on every route are tested in test_auth.py with the
real Auth and AuthMiddleware."""
import functools

import main
from auth import User

NAVEEN = User(1, "naveen", "Naveen")


class SignedIn:
    """Stands in for auth.Auth: every request is this user's (no cookie needed)."""

    def __init__(self, user=NAVEEN):
        self.user = user

    def session_user(self, token):
        return self.user, False

    def logout(self, token):
        pass


create_app = functools.partial(main.create_app, auth=SignedIn())


from fastapi.testclient import TestClient  # noqa: E402


class StrategyClient(TestClient):
    """TestClient that adds ?strategy=<id> to every request that doesn't name one (the paper / scalper routes)."""

    def __init__(self, app, strategy, **kw):
        super().__init__(app, **kw)
        self.strategy = str(strategy)

    def request(self, method, url, *args, **kw):
        url = str(url)
        if "strategy=" not in url:
            url += f"{'&' if '?' in url else '?'}strategy={self.strategy}"
        return super().request(method, url, *args, **kw)
