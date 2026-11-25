"""Refresh-mode select for OpenDisplay devices.

Offers display 0's drive modes (0xAE) by name. Modes the config flags
EXPERIMENTAL appear only after the opt-in in the options flow. The selection is
what upload_image and drawcustom use unless a call names a ``mode``; the
attributes show what the last upload actually ran (a stock full first, a scrub,
or the other temperature band's variant).
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.select import SelectEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import CONNECTION_BLUETOOTH, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import OpenDisplayConfigEntry
from .const import SIGNAL_DRIVE_RUN
from .refresh_modes import (
    DriveRun,
    RefreshModeStore,
    drive_options,
    experimental_enabled,
    selectable_modes,
    stock_mode,
)

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OpenDisplayConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the refresh-mode select when the display declares more than one mode."""
    runtime = entry.runtime_data
    store = runtime.refresh_modes
    modes = selectable_modes(runtime.device_config, experimental_enabled(entry))
    if store is None or len(modes) < 2:
        return
    async_add_entities([OpenDisplayRefreshModeSelect(entry, store)])


class OpenDisplayRefreshModeSelect(SelectEntity):
    """The drive mode uploads run in."""

    _attr_has_entity_name = True
    _attr_translation_key = "refresh_mode"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, entry: OpenDisplayConfigEntry, store: RefreshModeStore) -> None:
        """Initialize the select from the display's config."""
        address = entry.unique_id
        assert address is not None
        self._address = address
        self._store = store
        config = entry.runtime_data.device_config
        self._modes = {
            mode.name: mode
            for mode in selectable_modes(config, experimental_enabled(entry))
        }
        stock = stock_mode(config)
        self._default = stock.name if stock is not None else next(iter(self._modes))
        self._attr_options = list(self._modes)
        self._attr_unique_id = f"{address}-refresh_mode"
        self._attr_device_info = DeviceInfo(
            connections={(CONNECTION_BLUETOOTH, address)}
        )

    @property
    def current_option(self) -> str:
        """The selected mode; the stock mode when none (or a stale one) is stored."""
        selected = self._store.selected
        return selected if selected in self._modes else self._default

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """The selected mode's metadata and the last upload's run."""
        attributes: dict[str, Any] = dict(
            drive_options(self._modes[self.current_option])
        )
        run = self._store.last_run
        if run is not None:
            attributes.update(
                {f"last_{key}": value for key, value in run.as_attributes().items()}
            )
        return attributes

    async def async_select_option(self, option: str) -> None:
        """Persist the selection."""
        self._store.set_selected(None if option == self._default else option)
        self.async_write_ha_state()

    async def async_added_to_hass(self) -> None:
        """Refresh the attributes after each upload."""

        @callback
        def _on_run(_run: DriveRun) -> None:
            self.async_write_ha_state()

        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, f"{SIGNAL_DRIVE_RUN}_{self._address}", _on_run
            )
        )
