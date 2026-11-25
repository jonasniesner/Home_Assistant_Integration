"""Refresh (drive) modes: which modes a display offers, and driving an upload in one.

A firmware 3.0 config declares its drive modes in 0xAE packets. Mode 0 is the
stock full refresh; others (a faster waveform, a temperature-band variant, a
host-built table) are opt-in. The device runs whichever mode it is asked for and
keeps no history, so the host decides per upload, with py-opendisplay's planner:

* which temperature band variant fits the last known panel temperature,
* whether a stock full (mode 0) or a scrub mode must run first (budget spent,
  band changed, drive data changed, state lost),
* and which inline tables the chosen mode needs (``INLINE_LUT``).

The per-device drive state, the prior frame and the last run live in a Home Assistant
``Store``; the drive state is keyed and fingerprinted exactly as the library's
``DriveStateStore`` protocol expects, so the planner reads it unchanged.
"""

from __future__ import annotations

import base64
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
import logging
import time
from typing import TYPE_CHECKING, Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store
import numpy as np

from opendisplay import (
    DitherMode,
    DriveModeSubstitutedError,
    FitMode,
    InvalidResponseError,
    RefreshMode,
    Rotation,
)
from opendisplay.exceptions import DriveEtagMismatchError
from opendisplay.models.config import GlobalConfig
from opendisplay.models.drive_ext import LutFamily
from opendisplay.models.ident import FirmwareTarget
from opendisplay.models.lut_assemble import assemble_subset_s6
from opendisplay.models.lut_lint import mode_problem
from opendisplay.models.panel_drive import LUT_SLOT_NONE, DisplayMode
from opendisplay.panels.drive_plan import DrivePlan, plan_drive, record_drive
from opendisplay.panels.drive_state import DriveState, drive_fingerprint
from opendisplay.panels.prior import PriorConflictError

from .const import (
    CONF_EXPERIMENTAL_MODES,
    DEFAULT_EXPERIMENTAL_MODES,
    DOMAIN,
    SIGNAL_DRIVE_RUN,
)

if TYPE_CHECKING:
    from opendisplay.device.api import Device

    from . import OpenDisplayConfigEntry

_LOGGER = logging.getLogger(__name__)

STOCK_MODE_INDEX = 0
# Mode names the device reaches through the plain upload's refresh mode rather
# than through CMD_DRIVE_WRITE_START (py-opendisplay reserves them in
# ``DisplayView.drive_mode``).
REFRESH_MODE_BY_NAME: dict[str, RefreshMode] = {"fast": RefreshMode.FAST}
# Reached only through a PartialState (the refresh_type "partial"), never selected.
HIDDEN_MODE_NAMES = frozenset({"partial"})
# Upload-path test modes: callable by name, never listed.
TEST_MODE_PREFIX = "test_"

# Inline-only tables: mode name -> the mode whose stored 0xAF table is the source
# the per-update table is assembled from (assemble_subset_s6: the slots of codes
# the frame does not use become the hold slot). ``adaptive`` runs on the set-6
# rails of the 7.3in Spectra 6 preset, the same rails as ``faster_cool``.
INLINE_TABLE_SOURCES: dict[str, str] = {"adaptive": "faster_cool"}
# Targets whose firmware NACKs INLINE_LUT (no LUT cache, OD_ERR_DRIVE_UNSUPPORTED).
_NO_INLINE_TARGETS = frozenset({FirmwareTarget.EFR32BG22, FirmwareTarget.TELINK})
# The 0x0085 NACK code for "unsupported on this target".
_UNSUPPORTED_NACK = "0x05"

STORAGE_VERSION = 1


class RefreshModeError(HomeAssistantError):
    """A drive-mode upload was refused before or by the device; nothing ran in that step."""


def display_modes(config: GlobalConfig | None) -> list[DisplayMode]:
    """Display 0's drive modes in ``mode_index`` order (first packet per index), without hidden ones."""
    if config is None or not config.displays:
        return []
    instance = config.displays[0].instance_number
    first: dict[int, DisplayMode] = {}
    for mode in config.display_modes:
        if mode.instance_number == instance and mode.mode_index not in first:
            first[mode.mode_index] = mode
    return [
        first[index]
        for index in sorted(first)
        if first[index].name.lower() not in HIDDEN_MODE_NAMES
    ]


def selectable_modes(
    config: GlobalConfig | None, include_experimental: bool
) -> list[DisplayMode]:
    """Return the modes offered for selection: experimental ones only with the opt-in, no test modes."""
    return [
        mode
        for mode in display_modes(config)
        if (include_experimental or not mode.experimental)
        and not mode.name.lower().startswith(TEST_MODE_PREFIX)
    ]


def stock_mode(config: GlobalConfig | None) -> DisplayMode | None:
    """Mode 0, the stock full refresh, when the config declares it."""
    return next(
        (m for m in display_modes(config) if m.mode_index == STOCK_MODE_INDEX), None
    )


def experimental_enabled(entry: ConfigEntry) -> bool:
    """Whether the user opted in to experimental refresh modes."""
    return bool(entry.options.get(CONF_EXPERIMENTAL_MODES, DEFAULT_EXPERIMENTAL_MODES))


def resolve_mode(
    config: GlobalConfig | None, name: str, include_experimental: bool
) -> DisplayMode:
    """Return the selectable mode called ``name`` (case-insensitive).

    Raises:
        ServiceValidationError: The device has no such mode, or it is experimental
            and the user has not opted in.

    """
    key = name.lower()
    for mode in display_modes(config):
        if mode.name.lower() != key:
            continue
        if mode.experimental and not include_experimental:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="refresh_mode_experimental",
                translation_placeholders={"mode": mode.name},
            )
        return mode
    names = ", ".join(m.name for m in selectable_modes(config, include_experimental))
    raise ServiceValidationError(
        translation_domain=DOMAIN,
        translation_key="refresh_mode_unknown",
        translation_placeholders={"mode": name, "modes": names or "none"},
    )


def uses_drive_write(mode: DisplayMode) -> bool:
    """Whether an upload in ``mode`` goes through CMD_DRIVE_WRITE_START.

    Mode 0 and the modes named after a refresh mode go through the plain upload
    (which also keeps the refresh_type's partial and fast paths).
    """
    return (
        mode.mode_index != STOCK_MODE_INDEX
        and mode.name.lower() not in REFRESH_MODE_BY_NAME
    )


def full_keeps_prior(entry: ConfigEntry, config: GlobalConfig | None) -> bool:
    """Whether a stock full should go through the drive write, to keep its frame as the prior.

    A plain upload's frame is not kept, so the hold-code mode after it would have to
    draw a stock full instead. Only worth it when the user opted in to experimental
    modes and the display declares a hold-code mode; the drive write leaves the same
    picture as the plain full.
    """
    return experimental_enabled(entry) and any(
        m.ext is not None and m.ext.hold_codes for m in display_modes(config)
    )


@dataclass(frozen=True)
class DriveRequest:
    """An upload in a drive mode: the image and the options the drive path honours."""

    mode: str
    image: Any  # PIL image, before rotate/fit/dither (show() does those itself)
    dither_mode: DitherMode
    fit: FitMode
    rotate: Rotation
    use_measured_palettes: bool
    compress: bool
    # Panel codes the encoded frame uses (S6 single-pass frames); None when unknown.
    codes: frozenset[int] | None = None


@dataclass(frozen=True)
class DriveRun:
    """What the latest upload asked for and what actually ran."""

    requested: str
    ran: tuple[str, ...]
    chosen: str
    temp_c: int | None
    budget_used: int | None
    budget_limit: int | None
    substituted: bool
    stock_full_first: bool = False
    near_edge: bool = False
    notes: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()
    at: float = field(default_factory=time.time)

    def as_attributes(self) -> dict[str, Any]:
        """Return the run as entity attributes."""
        data = asdict(self)
        data["ran"] = list(self.ran)
        data["notes"] = list(self.notes)
        data["reasons"] = list(self.reasons)
        return data


class RefreshModeStore:
    """Per-entry persistence of the selected mode, the drive state and the last run.

    ``get`` / ``put`` / ``forget`` follow py-opendisplay's ``DriveStateStore``
    protocol over the loaded document; writes are saved with a short delay.
    """

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        """Create the store for one config entry."""
        self._store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, f"{DOMAIN}.refresh_modes.{entry_id}"
        )
        self._data: dict[str, Any] = {
            "selected": None,
            "devices": {},
            "last_run": None,
            "priors": {},
        }

    async def async_load(self) -> None:
        """Load the stored document; a missing or malformed one starts empty."""
        stored = await self._store.async_load()
        if isinstance(stored, dict):
            devices = stored.get("devices")
            self._data = {
                "selected": stored.get("selected")
                if isinstance(stored.get("selected"), str)
                else None,
                "devices": devices if isinstance(devices, dict) else {},
                "last_run": stored.get("last_run")
                if isinstance(stored.get("last_run"), dict)
                else None,
                "priors": stored.get("priors")
                if isinstance(stored.get("priors"), dict)
                else {},
            }

    async def async_flush(self) -> None:
        """Write pending changes now (the entry is unloading)."""
        await self._store.async_save(self._data)

    async def async_remove(self) -> None:
        """Delete the stored document (the entry is being removed)."""
        await self._store.async_remove()

    @callback
    def _schedule_save(self) -> None:
        self._store.async_delay_save(lambda: self._data, 1.0)

    # -- DriveStateStore protocol ------------------------------------------

    def get(self, name: str) -> DriveState | None:
        """Return the drive state of ``name``, or None."""
        return DriveState.from_json(self._data["devices"].get(name))

    def put(self, name: str, state: DriveState) -> None:
        """Replace the drive state of ``name``."""
        if not name:
            raise ValueError("device name required")
        self._data["devices"][name] = state.to_json()
        self._schedule_save()

    def forget(self, name: str) -> None:
        """Drop the drive state of ``name``; its next costed drive starts with a stock full."""
        if self._data["devices"].pop(name, None) is not None:
            self._schedule_save()

    # -- prior frame (what the panel shows now) -----------------------------

    def get_prior(self, name: str, fingerprint: str) -> bytes | None:
        """Return the frame the panel shows now, when recorded against these drive packets."""
        raw = self._data["priors"].get(name)
        if not isinstance(raw, dict) or raw.get("fingerprint") != fingerprint:
            return None
        try:
            return base64.b64decode(raw["frame"])
        except KeyError, TypeError, ValueError:
            return None

    def get_prior_etag(self, name: str, fingerprint: str) -> int | None:
        """Return the etag the device gave the prior frame (protocol 2.5), or None."""
        raw = self._data["priors"].get(name)
        if not isinstance(raw, dict) or raw.get("fingerprint") != fingerprint:
            return None
        etag = raw.get("etag")
        return etag if isinstance(etag, int) and not isinstance(etag, bool) else None

    def put_prior(
        self, name: str, fingerprint: str, frame: bytes | None, etag: int | None = None
    ) -> None:
        """Record the frame the panel shows now (None = unknown) and its etag."""
        if frame is None:
            self.forget_prior(name)
            return
        self._data["priors"][name] = {
            "fingerprint": fingerprint,
            "frame": base64.b64encode(frame).decode(),
            **({"etag": etag} if etag is not None else {}),
        }
        self._schedule_save()

    def forget_prior(self, name: str) -> None:
        """Forget the prior: the panel's content is unknown (a plain upload, or a failed drive)."""
        if self._data["priors"].pop(name, None) is not None:
            self._schedule_save()

    # -- legacy selection and last run ---------------------------------------

    def pop_selected(self) -> str | None:
        """Return (once, then clear) the mode the removed Refresh mode select had stored."""
        name = self._data.get("selected")
        if name is None:
            return None
        self._data["selected"] = None
        self._schedule_save()
        return name

    @property
    def last_run(self) -> DriveRun | None:
        """The latest upload's run, when one is stored."""
        raw = self._data.get("last_run")
        if not isinstance(raw, dict):
            return None
        try:
            return DriveRun(
                requested=str(raw["requested"]),
                ran=tuple(raw.get("ran", ())),
                chosen=str(raw["chosen"]),
                temp_c=raw.get("temp_c"),
                budget_used=raw.get("budget_used"),
                budget_limit=raw.get("budget_limit"),
                substituted=bool(raw.get("substituted", False)),
                stock_full_first=bool(raw.get("stock_full_first", False)),
                near_edge=bool(raw.get("near_edge", False)),
                notes=tuple(raw.get("notes", ())),
                reasons=tuple(raw.get("reasons", ())),
                at=float(raw.get("at", 0.0)),
            )
        except KeyError, TypeError, ValueError:
            return None

    def set_last_run(self, run: DriveRun) -> None:
        """Persist the latest run."""
        self._data["last_run"] = run.as_attributes()
        self._schedule_save()


def _store(entry: OpenDisplayConfigEntry) -> RefreshModeStore:
    store = entry.runtime_data.refresh_modes
    if store is None:
        raise HomeAssistantError("refresh-mode storage is not loaded")
    return store


def _device_key(entry: OpenDisplayConfigEntry) -> str:
    return entry.unique_id or entry.entry_id


def _budget_limit(config: GlobalConfig) -> int | None:
    if not config.displays:
        return None
    instance = config.displays[0].instance_number
    panel = next(
        (p for p in config.display_panels if p.instance_number == instance), None
    )
    ext = panel.ext if panel is not None else None
    if ext is None or ext.budget_limit is None or ext.budget_limit == 0xFF:
        return None
    return ext.budget_limit


def _lut_family(config: GlobalConfig, mode: DisplayMode) -> int:
    panel = next(
        (p for p in config.display_panels if p.instance_number == mode.instance_number),
        None,
    )
    ext = panel.ext if panel is not None else None
    return ext.lut_family if ext is not None and ext.lut_family is not None else 0


def last_temperature(
    entry: OpenDisplayConfigEntry, state: DriveState | None
) -> int | None:
    """Return the latest panel temperature: the last drive ACK's, else the advertised chip temperature."""
    if state is not None and state.last_temp_c is not None:
        return state.last_temp_c
    data = entry.runtime_data.coordinator.data
    advertisement = getattr(data, "advertisement", None) if data is not None else None
    reading = getattr(advertisement, "temperature_c", None)
    if isinstance(reading, int | float):
        return round(reading)
    return None


def frame_codes(
    frames: bytes, config: GlobalConfig, mode: DisplayMode
) -> frozenset[int] | None:
    """Return the panel codes a single-pass S6 frame uses (one code per 4-bit nibble), else None."""
    if mode.passes != 1 or _lut_family(config, mode) != LutFamily.S6_800 or not frames:
        return None
    packed = np.frombuffer(frames, dtype=np.uint8)
    nibbles = np.concatenate((packed >> 4, packed & 0x0F))
    return frozenset(int(code) for code in np.unique(nibbles))


def _stored_table(config: GlobalConfig, mode: DisplayMode) -> bytes | None:
    slot = next((s for s in mode.lut_slots if s != LUT_SLOT_NONE), None)
    if slot is None:
        return None
    lut = next(
        (
            lut
            for lut in config.display_luts
            if lut.instance_number == mode.instance_number and lut.slot_id == slot
        ),
        None,
    )
    if lut is None or not lut.crc_valid:
        return None
    try:
        return lut.waveform
    except ValueError:
        return None


def inline_tables(
    config: GlobalConfig, mode: DisplayMode, codes: frozenset[int] | None
) -> dict[int, bytes] | None:
    """Return the inline tables ``mode`` needs for one upload, or None when its stored slots suffice.

    Raises:
        RefreshModeError: The mode needs a table that cannot be built here.

    """
    family = _lut_family(config, mode)
    stored = config.display_luts
    if mode_problem(mode, lut_family=family, stored_luts=stored) is None:
        return None
    source_name = INLINE_TABLE_SOURCES.get(mode.name.lower())
    if source_name is None:
        raise RefreshModeError(
            f"Drive mode '{mode.name}' needs a table that is not stored on the display, "
            "and Home Assistant does not know how to build it"
        )
    if family != LutFamily.S6_800:
        raise RefreshModeError(
            f"Drive mode '{mode.name}': inline tables are built only for S6-800 panels "
            f"(this panel declares LUT family {family})"
        )
    if codes is None:
        raise RefreshModeError(
            f"Drive mode '{mode.name}': the frame's panel codes are unknown, so its table cannot be built"
        )
    source = next(
        (
            m
            for m in display_modes(config)
            if m.name.lower() == source_name
            and m.instance_number == mode.instance_number
        ),
        None,
    )
    table = _stored_table(config, source) if source is not None else None
    if table is None:
        raise RefreshModeError(
            f"Drive mode '{mode.name}' builds its table from the stored table of "
            f"'{source_name}', which this display does not have"
        )
    slots = sorted({s for s in mode.lut_slots if s != LUT_SLOT_NONE})
    try:
        built = assemble_subset_s6(table, codes)
    except ValueError as err:
        raise RefreshModeError(
            f"Drive mode '{mode.name}': the table could not be built: {err}"
        ) from err
    tables = dict.fromkeys(slots, built)
    problem = mode_problem(
        mode, lut_family=family, stored_luts=stored, inline_luts=tables
    )
    if problem is not None:
        raise RefreshModeError(
            f"Drive mode '{mode.name}' would still be refused with the built table: {problem}"
        )
    return tables


def _mode_by_index(config: GlobalConfig, index: int) -> DisplayMode:
    return next(m for m in display_modes(config) if m.mode_index == index)


@callback
def _publish(entry: OpenDisplayConfigEntry, hass: HomeAssistant, run: DriveRun) -> None:
    _store(entry).set_last_run(run)
    async_dispatcher_send(hass, f"{SIGNAL_DRIVE_RUN}_{entry.unique_id}", run)


def plan_upload(
    entry: OpenDisplayConfigEntry, config: GlobalConfig, mode_name: str
) -> tuple[DrivePlan, DriveState | None, int | None]:
    """Plan one upload in ``mode_name`` from the stored state and the latest temperature.

    Raises:
        ServiceValidationError: The planner refuses the mode (unknown, experimental
            without the opt-in, or a scrub/band mode the config lacks).

    """
    store = _store(entry)
    state = store.get(_device_key(entry))
    temp_c = last_temperature(entry, state)
    try:
        plan = plan_drive(
            config,
            state,
            temp_c,
            mode_name,
            include_experimental=experimental_enabled(entry),
        )
    except ValueError as err:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="refresh_mode_refused",
            translation_placeholders={"mode": mode_name, "error": str(err)},
        ) from err
    return plan, state, temp_c


def _rebooted_since_last_connect(entry: OpenDisplayConfigEntry, device: Device) -> bool:
    """Whether the latest advertisement still carries the reboot flag.

    The firmware sets it at boot and clears it on the first connection, so a set flag means
    nobody has connected since a reboot that may have redrawn the panel. Sleepy devices set
    it on every wake (unpersisted), so it says nothing there.
    """
    if getattr(device.profile, "is_sleepy", False):
        return False
    coordinator = getattr(entry.runtime_data, "coordinator", None)
    update = getattr(coordinator, "data", None)
    advertisement = getattr(update, "advertisement", None)
    return getattr(advertisement, "reboot_flag", None) is True


async def _show(
    device: Device,
    request: DriveRequest,
    name: str,
    tables: dict[int, bytes] | None,
    prior: bytes | None,
    prior_etag: int | None = None,
) -> int | None:
    """One drive upload; library errors become RefreshModeError.

    PriorConflictError and DriveEtagMismatchError pass: the caller draws stock instead.
    """
    try:
        return await device.display.show(
            request.image,
            mode=name,
            dither_mode=request.dither_mode,
            fit=request.fit,
            rotate=request.rotate,
            use_measured_palettes=request.use_measured_palettes,
            compress=request.compress,
            inline_luts=tables,
            prior=prior,
            prior_etag=prior_etag,
        )
    except DriveModeSubstitutedError as err:
        raise RefreshModeError(
            f"The display runs mode {err.actual} instead of '{name}'"
            f"{f' at {err.temp_c} °C' if err.temp_c is not None else ''}; nothing was uploaded"
        ) from err
    except InvalidResponseError as err:
        if tables and _UNSUPPORTED_NACK in str(err):
            raise RefreshModeError(
                f"The display refused the inline table for '{name}': its "
                "firmware does not accept INLINE_LUT"
            ) from err
        raise
    except PriorConflictError:
        raise
    except ValueError as err:
        raise RefreshModeError(
            f"Drive mode '{name}' was refused before sending: {err}"
        ) from err


async def async_drive_upload(
    hass: HomeAssistant,
    entry: OpenDisplayConfigEntry,
    device: Device,
    request: DriveRequest,
) -> DriveRun:
    """Upload ``request`` in its drive mode, as the host-side plan says, and record each drive.

    Every step of the plan (a stock full first, a scrub, then the update itself,
    possibly the other temperature band's variant) is shown with the same image.

    Raises:
        ServiceValidationError: The planner refused the mode.
        RefreshModeError: An inline table cannot be built or sent, or the device
            ran another mode than the one asked for.

    """
    config = device.config.cached or entry.runtime_data.device_config
    plan, state, temp_c = plan_upload(entry, config, request.mode)

    inline: dict[int, dict[int, bytes]] = {}
    for step in plan.steps:
        tables = inline_tables(
            config, _mode_by_index(config, step.mode_index), request.codes
        )
        if tables is not None:
            inline[step.mode_index] = tables
    if inline and device.profile.target in _NO_INLINE_TARGETS:
        raise RefreshModeError(
            f"Drive mode '{plan.steps[-1].name}' needs an inline table, which this "
            "display's firmware target does not accept (INLINE_LUT unsupported)"
        )

    store = _store(entry)
    key = _device_key(entry)
    fingerprint = drive_fingerprint(config)
    prior = store.get_prior(key, fingerprint)
    prior_etag = store.get_prior_etag(key, fingerprint)
    if prior is not None and _rebooted_since_last_connect(entry, device):
        _LOGGER.info(
            "%s: the device rebooted since the last upload; prior frame dropped",
            entry.unique_id,
        )
        store.forget_prior(key)
        prior = None
        prior_etag = None
    ran: list[str] = []
    driven: int | None = None
    for step in plan.steps:
        step_mode = _mode_by_index(config, step.mode_index)
        name = step.name
        use_prior = (
            prior if step_mode.ext is not None and step_mode.ext.hold_codes else None
        )
        if step_mode.ext is not None and step_mode.ext.hold_codes and prior is None:
            # Unknown panel content: a hold-code mode would drive every pixel; draw stock.
            stock = stock_mode(config)
            if stock is not None:
                name, step_mode = stock.name, stock
        tables = inline.get(step_mode.mode_index)
        store.forget_prior(key)
        try:
            temp_c = await _show(
                device,
                request,
                name,
                tables,
                use_prior,
                prior_etag if use_prior is not None else None,
            )
        except (PriorConflictError, DriveEtagMismatchError) as err:
            stock = stock_mode(config)
            if stock is None:
                raise RefreshModeError(str(err)) from err
            _LOGGER.info("%s: %s; drawing stock '%s'", entry.unique_id, err, stock.name)
            name, step_mode = stock.name, stock
            temp_c = await _show(device, request, name, None, None)
        frame = getattr(device.display, "last_frame", None)
        prior = bytes(frame) if isinstance(frame, (bytes, bytearray)) else None
        etag = getattr(device.display, "last_etag", None)
        prior_etag = (
            etag if isinstance(etag, int) and not isinstance(etag, bool) else None
        )
        changed = getattr(device.display, "last_changed", None)
        driven = changed if isinstance(changed, int) else None
        store.put_prior(key, fingerprint, prior, prior_etag)
        ran.append(name)
        state = record_drive(config, state, step_mode.mode_index, temp_c)
        store.put(key, state)

    chosen = ran[-1]
    requested = _mode_by_index(config, plan.requested).name
    run = DriveRun(
        requested=requested,
        ran=tuple(ran),
        chosen=chosen,
        temp_c=temp_c,
        budget_used=state.budget_used if state is not None else None,
        budget_limit=_budget_limit(config),
        substituted=plan.chosen != plan.requested or chosen != plan.steps[-1].name,
        stock_full_first=plan.stock_full_first,
        near_edge=plan.near_edge,
        notes=plan.notes
        + ((f"prior: drove {driven} changed pixels",) if driven is not None else ()),
        reasons=tuple(step.reason for step in plan.steps),
    )
    _publish(entry, hass, run)
    _LOGGER.info(
        "%s: drive upload asked for '%s', ran %s (temp %s C, budget %s/%s)",
        entry.unique_id,
        requested,
        ", ".join(ran),
        temp_c,
        run.budget_used,
        run.budget_limit,
    )
    return run


@callback
def record_plain_upload(
    hass: HomeAssistant,
    entry: OpenDisplayConfigEntry,
    config: GlobalConfig,
    refresh_mode: RefreshMode,
) -> None:
    """Fold a plain (non drive-write) upload into the drive state.

    A full refresh runs mode 0, which resets the budget; a fast refresh runs the
    mode named "fast" when the config declares one. Partial updates change nothing.
    """
    if entry.runtime_data.refresh_modes is not None:
        # A plain upload's frame is not kept, so the panel content is unknown from now on.
        _store(entry).forget_prior(_device_key(entry))
    modes = display_modes(config)
    if not modes or entry.runtime_data.refresh_modes is None:
        return
    if refresh_mode is RefreshMode.FULL:
        mode = next((m for m in modes if m.mode_index == STOCK_MODE_INDEX), None)
    elif refresh_mode is RefreshMode.FAST:
        mode = next((m for m in modes if m.name.lower() == "fast"), None)
    else:
        mode = None
    if mode is None:
        return
    store = _store(entry)
    key = _device_key(entry)
    state = store.get(key)
    try:
        state = record_drive(
            config, state, mode.mode_index, state.last_temp_c if state else None
        )
    except ValueError:
        return
    store.put(key, state)
    _publish(
        entry,
        hass,
        DriveRun(
            requested=mode.name,
            ran=(mode.name,),
            chosen=mode.name,
            temp_c=state.last_temp_c,
            budget_used=state.budget_used,
            budget_limit=_budget_limit(config),
            substituted=False,
        ),
    )


def drive_options(mode: DisplayMode) -> Mapping[str, Any]:
    """Descriptive attributes of a mode (the Last refresh mode sensor lists them)."""
    ext = mode.ext
    return {
        "mode_index": mode.mode_index,
        "experimental": mode.experimental,
        "budget_cost": ext.budget_cost if ext is not None else None,
        "temp_window_c": None
        if (mode.temp_min_c, mode.temp_max_c) == (0, 0)
        else [mode.temp_min_c, mode.temp_max_c],
    }
