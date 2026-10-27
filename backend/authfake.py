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
