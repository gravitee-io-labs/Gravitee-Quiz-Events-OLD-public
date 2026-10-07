"""
Scoreboard data + in-process live hub for the SSE streams (docs/ARCHITECTURE.md section 5.1).

Data
----
``fetch_entries`` / ``fetch_totals`` / ``build_snapshot`` run the scoreboard queries (names shortened
to "First L.", never e-mail / phone; order: score desc, ``completed_at`` asc, id asc). The REST
endpoint and the hub share them.

Hub (``ScoreboardHub``, one asyncio instance per process, module level ``hub``)
------------------------------------------------------------------------------
Designed for hundreds of viewers per event:

* ONE background task per event, alive only while that event has subscribers. It reloads the
  top-``MAX_ENTRIES`` snapshot with a short-lived DB session (``run_in_threadpool``) every
  ``refresh_interval`` seconds (default 4, so a score written by another replica shows up within 5 s)
  and immediately when ``notify_event_changed`` is called (bursts are coalesced by
  ``min_refresh_interval``).
* The payload is computed once per refresh (top 100) and serialised once per distinct ``limit``;
  every subscriber only picks its slice. A subscriber receives a message only when ITS slice changed.
* ``: keepalive`` comment after ``keepalive_interval`` (15 s) of silence.
* A subscriber never owns a DB session. When it leaves (disconnect, cancellation, ``aclose``), it is
  removed; the last one stops the event task and drops the channel (no work without viewers).
* ``notify_event_changed`` may be called from any thread (the sync endpoints run in the threadpool):
  it only does ``loop.call_soon_threadsafe``. Without subscribers it is a no-op.

Other replicas are not notified (the hub is in-process): they pick the change up on their next
periodic refresh.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app import database
from app.models import GameSession, Player
from app.schemas import ScoreboardEntry
from app.services.events import display_name

logger = logging.getLogger(__name__)

MAX_ENTRIES = 100
DEFAULT_REFRESH_INTERVAL = 4.0  # seconds; must stay <= 5 (contract)
DEFAULT_MIN_REFRESH_INTERVAL = 0.25  # coalesces bursts of notifications
DEFAULT_KEEPALIVE_INTERVAL = 15.0
DEFAULT_POLL_INTERVAL = 1.0  # how often an idle stream checks that its client is still there


# ---------------------------------------------------------------------------------------------
# Scoreboard queries (shared by the REST endpoint and the hub)
# ---------------------------------------------------------------------------------------------
def fetch_entries(db: Session, event_id: int, limit: int = MAX_ENTRIES) -> list[ScoreboardEntry]:
    """Top completed games of ``event_id`` (one row per game session), ranked by position."""
    stmt = (
        select(
            GameSession.id,
            GameSession.total_score,
            GameSession.correct_answers,
            GameSession.wrong_answers,
            GameSession.completed_at,
            Player.first_name,
            Player.last_name,
        )
        .join(Player, Player.id == GameSession.player_id)
        .where(GameSession.event_id == event_id, GameSession.status == "completed")
        .order_by(
            GameSession.total_score.desc(),
            GameSession.completed_at.asc().nulls_last(),
            GameSession.id.asc(),
        )
        .limit(limit)
    )
    return [
        ScoreboardEntry(
            id=row.id,
            rank=position,
            player_name=display_name(row.first_name, row.last_name),
            score=row.total_score,
            correct_answers=row.correct_answers,
            wrong_answers=row.wrong_answers,
            completed_at=row.completed_at,
        )
        for position, row in enumerate(db.execute(stmt), start=1)
    ]


def fetch_totals(db: Session, event_id: int) -> tuple[int, int]:
    """``(total_players, total_games)``: distinct players with a completed game, completed games."""
    players, games = db.execute(
        select(func.count(func.distinct(GameSession.player_id)), func.count(GameSession.id)).where(
            GameSession.event_id == event_id, GameSession.status == "completed"
        )
    ).one()
    return int(players or 0), int(games or 0)


@dataclass(frozen=True, eq=False)
class Snapshot:
    """Immutable scoreboard state of one event: top entries (JSON-ready dicts) + totals."""

    entries: tuple[dict[str, Any], ...]
    total_players: int
    total_games: int
    _json: dict[int, str] = field(default_factory=dict, repr=False, compare=False)

    def same_content(self, other: Snapshot) -> bool:
        return (
            self.entries == other.entries
            and self.total_players == other.total_players
            and self.total_games == other.total_games
        )

    def json_for(self, limit: int) -> str:
        """The SSE ``data`` payload for the first ``limit`` entries (serialised once per limit)."""
        cached = self._json.get(limit)
        if cached is None:
            cached = json.dumps(
                {
                    "entries": list(self.entries[:limit]),
                    "total_players": self.total_players,
                    "total_games": self.total_games,
                },
                separators=(",", ":"),
            )
            self._json[limit] = cached
        return cached


def build_snapshot(db: Session, event_id: int, limit: int = MAX_ENTRIES) -> Snapshot:
    entries = fetch_entries(db, event_id, limit)
    total_players, total_games = fetch_totals(db, event_id)
    return Snapshot(
        entries=tuple(entry.model_dump(mode="json") for entry in entries),
        total_players=total_players,
        total_games=total_games,
    )


def load_snapshot(event_id: int) -> Snapshot:
    """Blocking: compute the snapshot with a short-lived session (call it through the threadpool)."""
    with database.SessionLocal() as db:
        return build_snapshot(db, event_id)


# ---------------------------------------------------------------------------------------------
# Hub
# ---------------------------------------------------------------------------------------------
class _Subscriber:
    __slots__ = ("limit", "wake")

    def __init__(self, limit: int):
        self.limit = limit
        self.wake = asyncio.Event()


class _Channel:
    """State shared by all the viewers of one event + the task that keeps it fresh."""

    def __init__(self, hub: ScoreboardHub, event_id: int):
        self.hub = hub
        self.event_id = event_id
        self.snapshot: Optional[Snapshot] = None
        self.subscribers: set[_Subscriber] = set()
        self.refresh = asyncio.Event()  # "reload now" (set by notifications)
        self.task: Optional[asyncio.Task] = None

    def publish(self, snapshot: Snapshot) -> None:
        if self.snapshot is not None and self.snapshot.same_content(snapshot):
            return  # unchanged: nobody is woken up, nothing is sent
        self.snapshot = snapshot
        for subscriber in self.subscribers:
            subscriber.wake.set()

    async def run(self) -> None:
        hub = self.hub
        while True:
            started = time.monotonic()
            self.refresh.clear()  # a notification arriving during the load triggers another round
            try:
                snapshot = await run_in_threadpool(hub.loader, self.event_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("Scoreboard refresh failed for event %s", self.event_id, exc_info=True)
            else:
                self.publish(snapshot)
            await asyncio.sleep(hub.min_refresh_interval)
            remaining = hub.refresh_interval - (time.monotonic() - started)
            try:
                await asyncio.wait_for(self.refresh.wait(), timeout=max(remaining, 0.0))
            except TimeoutError:
                pass

    def discard(self, subscriber: _Subscriber) -> None:
        self.subscribers.discard(subscriber)
        if not self.subscribers:
            self.hub._drop_channel(self)


class ScoreboardHub:
    """Per-event fan-out of scoreboard snapshots to SSE subscribers (see the module docstring)."""

    def __init__(
        self,
        loader: Optional[Callable[[int], Snapshot]] = None,
        *,
        refresh_interval: float = DEFAULT_REFRESH_INTERVAL,
        min_refresh_interval: float = DEFAULT_MIN_REFRESH_INTERVAL,
        keepalive_interval: float = DEFAULT_KEEPALIVE_INTERVAL,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        max_entries: int = MAX_ENTRIES,
    ):
        self.loader = loader or load_snapshot
        self.refresh_interval = refresh_interval
        self.min_refresh_interval = min_refresh_interval
        self.keepalive_interval = keepalive_interval
        self.poll_interval = poll_interval
        self.max_entries = max_entries
        self._channels: dict[int, _Channel] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # -- introspection ---------------------------------------------------------------------
    def channel_count(self) -> int:
        return len(self._channels)

    def subscriber_count(self, event_id: Optional[int] = None) -> int:
        if event_id is not None:
            channel = self._channels.get(event_id)
            return len(channel.subscribers) if channel else 0
        return sum(len(c.subscribers) for c in self._channels.values())

    # -- notifications (thread safe) ---------------------------------------------------------
    def notify(self, event_id: int) -> None:
        """Ask for an immediate refresh of ``event_id``. Callable from any thread; no-op when idle."""
        loop = self._loop
        if loop is None:
            return
        try:
            loop.call_soon_threadsafe(self._wake, event_id)
        except RuntimeError:  # the loop is closed (shutdown)
            pass

    def _wake(self, event_id: int) -> None:
        channel = self._channels.get(event_id)
        if channel is not None:
            channel.refresh.set()

    # -- channels ----------------------------------------------------------------------------
    def _channel_for(self, event_id: int) -> _Channel:
        channel = self._channels.get(event_id)
        if channel is None:
            channel = _Channel(self, event_id)
            self._channels[event_id] = channel
            self._loop = asyncio.get_running_loop()
            channel.task = asyncio.create_task(channel.run(), name=f"scoreboard-hub-{event_id}")
        return channel

    def _drop_channel(self, channel: _Channel) -> None:
        if self._channels.get(channel.event_id) is channel:
            del self._channels[channel.event_id]
        if channel.task is not None:
            try:
                channel.task.cancel()
            except RuntimeError:  # event loop already closed (generator finalised at shutdown)
                pass
            channel.task = None
        if not self._channels:
            self._loop = None

    async def aclose(self) -> None:
        """Stop every refresh task (app shutdown / tests). Open streams end at their next wake-up."""
        channels = list(self._channels.values())
        self._channels.clear()
        self._loop = None
        tasks = [c.task for c in channels if c.task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # -- SSE ---------------------------------------------------------------------------------
    async def stream(
        self,
        event_id: int,
        limit: int = 10,
        is_disconnected: Optional[Callable[[], Awaitable[bool]]] = None,
    ) -> AsyncIterator[str]:
        """SSE frames for one viewer: ``data: {...}`` on connect and on change, ``: keepalive`` when idle.

        ``is_disconnected`` (``request.is_disconnected``) is polled so a vanished client is noticed
        within ``poll_interval`` even when nothing is written to it.
        """
        limit = max(1, min(int(limit), self.max_entries))
        channel = self._channel_for(event_id)
        subscriber = _Subscriber(limit)
        channel.subscribers.add(subscriber)
        last_data: Optional[str] = None
        last_write = time.monotonic()
        try:
            while True:
                subscriber.wake.clear()  # clear BEFORE reading: a publish in between keeps it set
                snapshot = channel.snapshot
                if snapshot is not None:
                    data = snapshot.json_for(limit)
                    if data != last_data:
                        last_data = data
                        last_write = time.monotonic()
                        yield f"data: {data}\n\n"

                idle_left = last_write + self.keepalive_interval - time.monotonic()
                timeout = max(0.0, min(self.poll_interval, idle_left))
                try:
                    await asyncio.wait_for(subscriber.wake.wait(), timeout=timeout)
                except TimeoutError:
                    pass
                if is_disconnected is not None and await is_disconnected():
                    return
                if time.monotonic() - last_write >= self.keepalive_interval:
                    last_write = time.monotonic()
                    yield ": keepalive\n\n"
        finally:
            channel.discard(subscriber)


hub = ScoreboardHub()


def notify_event_changed(event_id: int) -> None:
    """Wake up the SSE streams of ``event_id`` after a score/result change (thread safe, never raises)."""
    try:
        hub.notify(event_id)
    except Exception:  # pragma: no cover - a notification must never break the caller's request
        logger.exception("Could not notify the scoreboard hub for event %s", event_id)
