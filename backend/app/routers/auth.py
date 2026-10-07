"""Admin authentication: login (throttled), logout (stateless) and /me."""
import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.auth import authenticate_admin, create_access_token, require_admin
from app.config import settings
from app.schemas import AdminMe, LoginRequest, MessageResponse, Token, TokenData
from app.security import get_client_ip, login_throttle, throttle_key

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Authentication"])


def _too_many(retry_after: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many failed login attempts. Try again later.",
        headers={"Retry-After": str(retry_after)},
    )


@router.post(
    "/login",
    response_model=Token,
    responses={401: {"description": "Bad credentials"}, 429: {"description": "Too many failures"}},
)
def login(credentials: LoginRequest, request: Request):
    """Exchange the admin credentials for a Bearer JWT.

    Failed attempts are counted per (client IP, username) over ``LOGIN_WINDOW_SECONDS`` (policy and
    trade-offs: ``app.security`` module docstring):

    * fewer than ``LOGIN_MAX_FAILURES``: wrong password = 401;
    * from ``LOGIN_MAX_FAILURES`` on: the credentials are checked first; a correct pair still logs in (and
      resets the counter), a wrong one is a 429 + ``Retry-After``;
    * from ``LOGIN_HARD_MAX_FAILURES`` on: 429 + ``Retry-After`` for every attempt, without checking the
      password. This is the cap on password guessing.
    """
    ip = get_client_ip(request)
    key = throttle_key(ip, credentials.username)

    state = login_throttle.status(key)
    if state.locked:
        logger.warning("Login locked for ip=%s user=%r", ip, credentials.username[:50])
        raise _too_many(state.locked_for)

    # constant-time check of both fields BEFORE the soft threshold is applied
    if authenticate_admin(credentials.username, credentials.password):
        login_throttle.reset(key)
        if state.throttled:
            logger.warning("Admin login ip=%s accepted while its failure threshold was exceeded", ip)
        expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
        token = create_access_token(settings.ADMIN_USERNAME, expires)
        logger.info("Admin login ip=%s", ip)
        return Token(access_token=token, token_type="bearer", expires_in=int(expires.total_seconds()))

    login_throttle.record_failure(key)
    logger.warning("Failed login ip=%s user=%r", ip, credentials.username[:50])
    if state.throttled:
        raise _too_many(login_throttle.retry_after(key) or state.throttled_for)
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Incorrect username or password",
        headers={"WWW-Authenticate": "Bearer"},
    )


@router.post("/logout", response_model=MessageResponse)
def logout():
    """Stateless JWT: the client simply discards its token."""
    return MessageResponse(message="Successfully logged out")


@router.get("/me", response_model=AdminMe)
def me(admin: TokenData = Depends(require_admin)):
    return AdminMe(username=admin.username or "")
