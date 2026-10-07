"""
Admin authentication: JWT creation / validation and the FastAPI dependencies.

Dependencies
------------
* ``get_current_admin``  -> ``TokenData`` or 401 (missing / invalid / expired token).
* ``require_admin``      -> same, plus the token subject must still be the configured admin.
* ``optional_admin``     -> ``TokenData`` or ``None`` (never raises) - public routes that show more
                            to admins (e.g. draft events).

ALL ``/api/admin`` routes MUST be protected. ``app.main`` mounts every admin router with
``dependencies=[Depends(require_admin)]``; routers should also be created with
``admin_router()`` so they stay protected when mounted elsewhere (e.g. in tests).
"""
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.config import settings
from app.schemas import TokenData
from app.security import constant_time_equals, verify_admin_credentials

# auto_error=False: we raise our own 401 (older Starlette/FastAPI answered 403 for a missing header)
bearer_scheme = HTTPBearer(auto_error=False)

_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


def authenticate_admin(username: str, password: str) -> bool:
    """True when the credentials match the env-configured admin (constant time, both fields)."""
    return verify_admin_credentials(username, password)


def create_access_token(subject: str, expires_delta: Optional[timedelta] = None) -> str:
    """Signed JWT with timezone-aware ``iat`` / ``exp`` claims."""
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    claims: dict[str, Any] = {"sub": subject, "iat": now, "exp": expire}
    return jwt.encode(claims, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> Optional[TokenData]:
    """Return the token data, or ``None`` if the token is invalid / expired / has no subject."""
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            options={"require_exp": True, "require_sub": True},
        )
    except JWTError:
        return None
    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject:
        return None
    return TokenData(username=subject)


def optional_admin(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> Optional[TokenData]:
    """The admin behind a valid Bearer token, else ``None`` (no/invalid token never raises)."""
    if credentials is None or not credentials.credentials:
        return None
    data = decode_access_token(credentials.credentials)
    if data is None or data.username is None:
        return None
    if not constant_time_equals(data.username, settings.ADMIN_USERNAME):
        return None
    return data


def get_current_admin(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> TokenData:
    """The authenticated admin or 401."""
    data = optional_admin(credentials)
    if data is None:
        raise _UNAUTHORIZED
    return data


def require_admin(admin: TokenData = Depends(get_current_admin)) -> TokenData:
    """Router-level guard: ``APIRouter(dependencies=[Depends(require_admin)])``."""
    return admin


def admin_router(**kwargs: Any) -> APIRouter:
    """An ``APIRouter`` whose every route requires an admin Bearer token.

    Usage in the admin routers::

        router = admin_router(tags=["Admin - Events"])
    """
    dependencies = [Depends(require_admin), *kwargs.pop("dependencies", [])]
    return APIRouter(dependencies=dependencies, **kwargs)
