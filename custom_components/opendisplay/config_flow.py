"""Config flow for OpenDisplay integration."""

import asyncio
from collections.abc import Mapping
import contextlib
import logging
from typing import TYPE_CHECKING, Any

from homeassistant.components.bluetooth import (
    BluetoothServiceInfoBleak,
    async_ble_device_from_address,
    async_discovered_service_info,
)
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
    OptionsFlowWithReload,
)
from homeassistant.const import CONF_ADDRESS
from homeassistant.core import callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.selector import (
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo
import voluptuous as vol

from opendisplay import (
    MANUFACTURER_ID,
    AuthenticationFailedError,
    AuthenticationRequiredError,
    BLEConnectionError,
    OpenDisplayError,
    Sec2KeyRequiredError,
    connect,
    parse_advertisement,
)

from .ble_lock import ble_connection
from .const import (
    CONF_DEFAULT_DRIVE_MODE,
    CONF_ENCRYPTION_KEY,
    CONF_EXPERIMENTAL_MODES,
    CONF_GITHUB_TOKEN,
    CONF_HOST,
    CONF_MISSED_CYCLES,
    CONF_PORT,
    CONF_PROBE_BEFORE_QUEUE,
    CONF_QUEUE_TIMEOUT_HOURS,
    CONF_SLEEP_MODE,
    CONF_TLS,
    CONNECT_PROBE_DEADLINE_S,
    DEFAULT_EXPERIMENTAL_MODES,
    DEFAULT_LAN_PORT,
    DEFAULT_MISSED_CYCLES,
    DEFAULT_PROBE_BEFORE_QUEUE,
    DEFAULT_QUEUE_TIMEOUT_HOURS,
    DEFAULT_SLEEP_MODE,
    DEFAULT_TLS_PORT,
    DOMAIN,
    SLEEP_MODE_AUTO,
    SLEEP_MODE_OFF,
    SLEEP_MODE_ON,
    TCP_CONNECT_TIMEOUT_S,
)
from .refresh_modes import experimental_enabled, selectable_modes
from .transport import note_mdns_seen

if TYPE_CHECKING:
    from .firmware_v3 import Preflight, UpgradeJob

_LOGGER = logging.getLogger(__name__)


# Firmware advertises as "OD" followed by the device id in hex.
NAME_PREFIX = "OD"


def _is_opendisplay(discovery_info: BluetoothServiceInfoBleak) -> bool:
    """Return if the advertisement looks like an OpenDisplay device."""
    if not discovery_info.name.startswith(NAME_PREFIX):
        return False
    if (data := discovery_info.manufacturer_data.get(MANUFACTURER_ID)) is None:
        return False
    try:
        parse_advertisement(data)
    except ValueError:
        return False
    return True


def _txt_str(properties: Mapping[str, Any], key: str) -> str | None:
    """Read a zeroconf TXT value as a stripped str (bytes tolerated), or None."""
    value = properties.get(key)
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")
    text = str(value).strip()
    return text or None


def _txt_bool(properties: Mapping[str, Any], key: str) -> bool:
    """Interpret a zeroconf TXT flag as boolean (``1``/``true``/``yes`` → True)."""
    value = _txt_str(properties, key)
    return value is not None and value.lower() in ("1", "true", "yes")


def _options_schema(drive_modes: list[str] | None = None) -> vol.Schema:
    """Return the options-flow schema.

    ``drive_modes`` are this display's selectable drive modes; with two or more,
    the form offers the default one (left empty, uploads run in the stock mode).
    """
    default_mode: dict[Any, Any] = (
        {
            vol.Optional(CONF_DEFAULT_DRIVE_MODE): SelectSelector(
                SelectSelectorConfig(
                    options=drive_modes,
                    mode=SelectSelectorMode.DROPDOWN,
                    translation_key="drive_mode",
                )
            )
        }
        if drive_modes is not None and len(drive_modes) > 1
        else {}
    )
    return vol.Schema(
        {
            vol.Required(CONF_SLEEP_MODE, default=DEFAULT_SLEEP_MODE): SelectSelector(
                SelectSelectorConfig(
                    options=[SLEEP_MODE_AUTO, SLEEP_MODE_ON, SLEEP_MODE_OFF],
                    translation_key="sleep_mode",
                    mode=SelectSelectorMode.DROPDOWN,
                )
            ),
            vol.Required(CONF_MISSED_CYCLES, default=DEFAULT_MISSED_CYCLES): vol.All(
                NumberSelector(
                    NumberSelectorConfig(
                        min=1, max=100, step=1, mode=NumberSelectorMode.BOX
                    )
                ),
                vol.Coerce(int),
            ),
            vol.Required(
                CONF_QUEUE_TIMEOUT_HOURS, default=DEFAULT_QUEUE_TIMEOUT_HOURS
            ): vol.All(
                NumberSelector(
                    NumberSelectorConfig(
                        min=1,
                        max=168,
                        step=1,
                        mode=NumberSelectorMode.BOX,
                        unit_of_measurement="h",
                    )
                ),
                vol.Coerce(int),
            ),
            vol.Required(
                CONF_PROBE_BEFORE_QUEUE, default=DEFAULT_PROBE_BEFORE_QUEUE
            ): BooleanSelector(),
            vol.Required(
                CONF_EXPERIMENTAL_MODES, default=DEFAULT_EXPERIMENTAL_MODES
            ): BooleanSelector(),
            **default_mode,
            vol.Optional(CONF_GITHUB_TOKEN): TextSelector(
                TextSelectorConfig(type=TextSelectorType.PASSWORD)
            ),
        }
    )


_ENCRYPTION_KEY_VALIDATOR = vol.All(str.strip, str.lower, vol.Match(r"^[0-9a-f]{32}$"))


class OpenDisplayConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for OpenDisplay."""

    def __init__(self) -> None:
        """Initialize the config flow."""
        self._discovery_info: BluetoothServiceInfoBleak | None = None
        self._discovered_devices: dict[str, BluetoothServiceInfoBleak] = {}
        # Zeroconf (WiFi/LAN) discovery of a not-yet-configured device.
        self._zeroconf_host: str | None = None
        self._zeroconf_port: int = DEFAULT_LAN_PORT
        self._zeroconf_tls: bool = False
        self._zeroconf_name: str = ""

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        """Return the options flow handler."""
        return OpenDisplayOptionsFlow()

    async def _async_test_connection(
        self, address: str, encryption_key: bytes | None = None
    ) -> None:
        """Connect to the device and verify it responds."""
        ble_device = async_ble_device_from_address(self.hass, address, connectable=True)
        if ble_device is None:
            raise BLEConnectionError(f"Could not find connectable device for {address}")

        # Bound the whole probe (link, firmware version, identity, security, config) so a
        # wedged BLE link can't freeze the config dialog. A breach is surfaced as
        # BLEConnectionError, which the callers' existing OpenDisplayError handling
        # maps to "cannot_connect"; AuthenticationRequiredError still propagates.
        try:
            async with asyncio.timeout(CONNECT_PROBE_DEADLINE_S):
                async with (
                    ble_connection(address, "connection probe (config flow)"),
                    connect(
                        address=address,
                        ble_device=ble_device,
                        encryption_key=encryption_key,
                    ),
                ):
                    pass
        except TimeoutError as err:
            raise BLEConnectionError(
                f"Connection probe exceeded {CONNECT_PROBE_DEADLINE_S:.0f}s"
            ) from err

    async def _async_test_connection_tcp(self, host: str, port: int) -> None:
        """Probe a TCP/LAN endpoint for reachability (zeroconf confirm step).

        A lightweight reachability check: open a TCP connection with a short
        timeout, then close it immediately. It does not speak the protocol (no
        interrogation) — full interrogation happens at entry setup, over WiFi or a
        BLE fallback. Deliberately separate from the BLE-only
        ``_async_test_connection`` so the two transports' probes stay independent.

        Raises:
            OSError / TimeoutError: if the endpoint is unreachable.

        """
        async with asyncio.timeout(TCP_CONNECT_TIMEOUT_S):
            _reader, writer = await asyncio.open_connection(host, port)
        writer.close()
        with contextlib.suppress(OSError):
            await writer.wait_closed()

    async def async_step_zeroconf(
        self, discovery_info: ZeroconfServiceInfo
    ) -> ConfigFlowResult:
        """Handle a WiFi (mDNS) discovery of an OpenDisplay device.

        The device is identified by its BLE MAC (the ``mac`` TXT key), so a
        WiFi-discovered tag dedups onto its existing BLE entry (and vice versa):
        the unique_id is the uppercase-colon MAC, matching the raw BlueZ form the
        bluetooth step stores. An already-configured entry just gains
        host/port/tls (and an mDNS-presence timestamp so the resolver can prefer
        WiFi); a brand-new device goes through a confirm step.
        """
        properties = discovery_info.properties
        mac = _txt_str(properties, "mac")
        if not mac:
            # Identity is anchored on the BLE MAC (SECTION 9); without it the
            # device can't be correlated with a BLE entry — ignore the record.
            return self.async_abort(reason="no_mac")

        unique_id = mac.upper()
        await self.async_set_unique_id(unique_id)

        tls = _txt_bool(properties, "tls")
        host = discovery_info.host
        port = discovery_info.port or (DEFAULT_TLS_PORT if tls else DEFAULT_LAN_PORT)

        # Feed mDNS presence to an already-loaded entry before the abort below
        # short-circuits: this doubles as a "device seen" wake trigger (union of
        # BLE advert + mDNS) and refreshes the WiFi-preference freshness window.
        self._async_note_mdns_for_configured(unique_id)

        # Existing entry (BLE or WiFi): merge in the live host/port/tls and abort.
        self._abort_if_unique_id_configured(
            updates={CONF_HOST: host, CONF_PORT: port, CONF_TLS: tls}
        )

        # New device discovered over WiFi first — confirm, then create the entry.
        self._zeroconf_host = host
        self._zeroconf_port = port
        self._zeroconf_tls = tls
        self._zeroconf_name = (
            discovery_info.name.removesuffix("._opendisplay._tcp.local.") or host
        )
        self.context["title_placeholders"] = {"name": self._zeroconf_name}
        return await self.async_step_zeroconf_confirm()

    @callback
    def _async_note_mdns_for_configured(self, unique_id: str) -> None:
        """Record the mDNS sighting on a matching loaded entry, if any."""
        for entry in self.hass.config_entries.async_entries(DOMAIN):
            if entry.unique_id == unique_id:
                note_mdns_seen(self.hass, entry)
                return

    async def async_step_zeroconf_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm a WiFi-discovered device and create its entry."""
        assert self._zeroconf_host is not None
        errors: dict[str, str] = {}
        name = self.context["title_placeholders"]["name"]

        if user_input is not None:
            try:
                await self._async_test_connection_tcp(
                    self._zeroconf_host, self._zeroconf_port
                )
            except OSError, TimeoutError:
                errors["base"] = "cannot_connect"
            except Exception:
                _LOGGER.exception("Unexpected error probing WiFi device")
                errors["base"] = "unknown"
            else:
                return self.async_create_entry(
                    title=name,
                    data={
                        CONF_HOST: self._zeroconf_host,
                        CONF_PORT: self._zeroconf_port,
                        CONF_TLS: self._zeroconf_tls,
                    },
                )

        self._set_confirm_only()
        return self.async_show_form(
            step_id="zeroconf_confirm",
            description_placeholders={"name": name},
            errors=errors,
        )

    async def async_step_bluetooth(
        self, discovery_info: BluetoothServiceInfoBleak
    ) -> ConfigFlowResult:
        """Handle the Bluetooth discovery step."""
        if not _is_opendisplay(discovery_info):
            return self.async_abort(reason="not_supported")
        await self.async_set_unique_id(discovery_info.address)
        self._abort_if_unique_id_configured()
        self._discovery_info = discovery_info
        self.context["title_placeholders"] = {"name": discovery_info.name}
        return await self.async_step_bluetooth_confirm()

    async def async_step_bluetooth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm discovery and connect to the device."""
        assert self._discovery_info is not None
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                await self._async_test_connection(self._discovery_info.address)
            except AuthenticationRequiredError, Sec2KeyRequiredError:
                _LOGGER.debug(
                    "%s: device requires an encryption key; prompting for one",
                    self._discovery_info.address,
                )
                return await self.async_step_encryption_key()
            except OpenDisplayError:
                errors["base"] = "cannot_connect"
            except Exception:
                _LOGGER.exception("Unexpected error")
                errors["base"] = "unknown"
            else:
                return self.async_create_entry(title=self._discovery_info.name, data={})

        self._set_confirm_only()
        return self.async_show_form(
            step_id="bluetooth_confirm",
            description_placeholders=self.context["title_placeholders"],
            errors=errors,
        )

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the user step to pick discovered device."""
        errors: dict[str, str] = {}

        if user_input is not None:
            address = user_input[CONF_ADDRESS]
            await self.async_set_unique_id(address, raise_on_progress=False)
            self._abort_if_unique_id_configured()

            try:
                await self._async_test_connection(address)
            except AuthenticationRequiredError, Sec2KeyRequiredError:
                _LOGGER.debug(
                    "%s: device requires an encryption key; prompting for one", address
                )
                self.context["title_placeholders"] = {
                    "name": self._discovered_devices[address].name
                }
                return await self.async_step_encryption_key()
            except OpenDisplayError:
                errors["base"] = "cannot_connect"
            except Exception:
                _LOGGER.exception("Unexpected error")
                errors["base"] = "unknown"
            else:
                return self.async_create_entry(
                    title=self._discovered_devices[address].name,
                    data={},
                )
        else:
            current_addresses = self._async_current_ids(include_ignore=False)
            for discovery_info in async_discovered_service_info(self.hass):
                address = discovery_info.address
                if address in current_addresses or address in self._discovered_devices:
                    continue
                if _is_opendisplay(discovery_info):
                    self._discovered_devices[address] = discovery_info

        if not self._discovered_devices:
            return self.async_abort(reason="no_devices_found")

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_ADDRESS): vol.In(
                        {
                            addr: f"{info.name} ({addr})"
                            for addr, info in self._discovered_devices.items()
                        }
                    )
                }
            ),
            errors=errors,
        )

    async def _async_try_connection(
        self,
        address: str,
        encryption_key: bytes | None,
        errors: dict[str, str],
    ) -> bool:
        """Test connection, populate errors, and return True on success."""
        try:
            await self._async_test_connection(address, encryption_key)
        except (
            AuthenticationFailedError,
            AuthenticationRequiredError,
            Sec2KeyRequiredError,
        ) as err:
            _LOGGER.debug("%s: encryption key rejected (%s)", address, err)
            errors[CONF_ENCRYPTION_KEY] = "invalid_auth"
        except OpenDisplayError:
            errors["base"] = "cannot_connect"
        except Exception:
            _LOGGER.exception("Unexpected error")
            errors["base"] = "unknown"
        else:
            return True
        return False

    async def async_step_encryption_key(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the encryption key step."""
        errors: dict[str, str] = {}
        name: str = self.context["title_placeholders"]["name"]

        if user_input is not None:
            try:
                key: str = _ENCRYPTION_KEY_VALIDATOR(user_input[CONF_ENCRYPTION_KEY])
            except vol.Invalid:
                errors[CONF_ENCRYPTION_KEY] = "invalid_key_format"
            else:
                if TYPE_CHECKING:
                    assert self.unique_id is not None
                if await self._async_try_connection(
                    self.unique_id, bytes.fromhex(key), errors
                ):
                    return self.async_create_entry(
                        title=name,
                        data={CONF_ENCRYPTION_KEY: key},
                    )

        return self.async_show_form(
            step_id="encryption_key",
            data_schema=vol.Schema({vol.Required(CONF_ENCRYPTION_KEY): str}),
            description_placeholders={"name": name},
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """Handle re-authentication."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle reauth confirmation."""
        reauth_entry = self._get_reauth_entry()
        errors: dict[str, str] = {}

        if user_input is not None:
            key: str | None = None
            if user_input[CONF_ENCRYPTION_KEY].strip():
                try:
                    key = _ENCRYPTION_KEY_VALIDATOR(user_input[CONF_ENCRYPTION_KEY])
                except vol.Invalid:
                    errors[CONF_ENCRYPTION_KEY] = "invalid_key_format"

            if not errors:
                address = reauth_entry.unique_id
                if TYPE_CHECKING:
                    assert address is not None
                if await self._async_try_connection(
                    address, bytes.fromhex(key) if key is not None else None, errors
                ):
                    new_data = dict(reauth_entry.data)
                    if key is not None:
                        new_data[CONF_ENCRYPTION_KEY] = key
                    else:
                        new_data.pop(CONF_ENCRYPTION_KEY, None)
                    return self.async_update_reload_and_abort(
                        reauth_entry,
                        data=new_data,
                    )

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema(
                {vol.Optional(CONF_ENCRYPTION_KEY, default=""): str}
            ),
            description_placeholders={"name": reauth_entry.title},
            errors=errors,
        )


class OpenDisplayOptionsFlow(OptionsFlowWithReload):
    """Handle deep-sleep options for an OpenDisplay device.

    Extends ``OptionsFlowWithReload`` so saving changed options automatically
    reloads the entry, re-resolving the sleep profile and re-applying the
    availability interval. No manual update listener is registered (mixing the
    two is disallowed).
    """

    _upgrade_task: asyncio.Task[Any] | None = None
    _preflight: Preflight | None = None
    _job: UpgradeJob | None = None
    _refusal: tuple[str, dict[str, str]] | None = None

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage the options; a BG22 on 2.x also offers the 3.x upgrade."""
        from .firmware_v3 import upgrade_supported

        if user_input is None and upgrade_supported(self.config_entry):
            return self.async_show_menu(
                step_id="init", menu_options=["settings", "firmware_v3"]
            )
        return await self._async_settings("init", user_input)

    async def async_step_settings(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage the deep-sleep, refresh-mode and update options."""
        return await self._async_settings("settings", user_input)

    async def _async_settings(
        self, step_id: str, user_input: dict[str, Any] | None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)

        return self.async_show_form(
            step_id=step_id,
            data_schema=self.add_suggested_values_to_schema(
                _options_schema(self._drive_modes()), self.config_entry.options
            ),
        )

    # --- guided firmware 3.x upgrade (firmware_v3.py) -----------------------
    #
    # firmware_v3 (explain) -> firmware_v3_check (progress: release + pre-flight)
    # -> firmware_v3_confirm[_untested] -> firmware_v3_flash (progress)
    # -> firmware_v3_migrate (progress) -> abort with the outcome. Every
    # refusal ends in an abort whose text says what happened and where the
    # backup is.

    async def async_step_firmware_v3(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Explain the upgrade; nothing touches the display before the user continues."""
        if user_input is None:
            return self.async_show_form(
                step_id="firmware_v3",
                description_placeholders={"name": self.config_entry.title},
            )
        return await self.async_step_firmware_v3_check()

    async def async_step_firmware_v3_check(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Find the 3.x image, back up the 2.x config and plan the migration."""
        from .firmware_v3 import (
            UpgradeRefusedError,
            async_find_release,
            async_preflight,
        )

        async def _check() -> Preflight:
            release = await async_find_release(self.hass, self.config_entry)
            return await async_preflight(self.hass, self.config_entry, release)

        if self._upgrade_task is None:
            self._upgrade_task = self.hass.async_create_task(_check())
        if not self._upgrade_task.done():
            return self.async_show_progress(
                step_id="firmware_v3_check",
                progress_action="firmware_v3_check",
                progress_task=self._upgrade_task,
            )
        task, self._upgrade_task = self._upgrade_task, None
        try:
            self._preflight = task.result()
        except UpgradeRefusedError as err:
            self._refusal = (err.reason, err.placeholders)
            return self.async_show_progress_done(next_step_id="firmware_v3_result")
        except Exception:
            # Nothing was flashed; end here rather than re-running the check.
            _LOGGER.exception("Firmware 3.x upgrade check failed")
            self._refusal = ("unknown", {})
            return self.async_show_progress_done(next_step_id="firmware_v3_result")
        next_step = (
            "firmware_v3_confirm_untested"
            if self._preflight.plan.needs_confirmation
            else "firmware_v3_confirm"
        )
        return self.async_show_progress_done(next_step_id=next_step)

    async def async_step_firmware_v3_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Flash once the user confirms what the pre-flight found."""
        return await self._async_confirm_upgrade("firmware_v3_confirm", user_input)

    async def async_step_firmware_v3_confirm_untested(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Flash a panel whose 3.x drive data nobody has watched draw yet."""
        return await self._async_confirm_upgrade(
            "firmware_v3_confirm_untested", user_input
        )

    async def _async_confirm_upgrade(
        self, step_id: str, user_input: dict[str, Any] | None
    ) -> ConfigFlowResult:
        preflight = self._preflight
        assert preflight is not None
        errors: dict[str, str] = {}
        if user_input is not None:
            if user_input.get("confirm"):
                return await self.async_step_firmware_v3_flash()
            errors["base"] = "confirm_required"
        return self.async_show_form(
            step_id=step_id,
            data_schema=vol.Schema(
                {vol.Required("confirm", default=False): BooleanSelector()}
            ),
            description_placeholders={
                "name": self.config_entry.title,
                "version": preflight.release.tag,
                "panel": preflight.panel,
                "size": str(preflight.config_bytes),
                "backup": str(preflight.backup),
            },
            errors=errors,
        )

    async def async_step_firmware_v3_flash(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Download and flash the 3.x image over BLE."""
        from .firmware_v3 import (
            UpgradeRefusedError,
            async_start_upgrade,
            async_wait_flashed,
            flash_error_placeholders,
        )

        preflight = self._preflight
        assert preflight is not None
        if self._job is None:

            def _on_progress(pct: float) -> None:
                self.async_update_progress(min(max(pct / 100, 0.0), 1.0))

            self._job = async_start_upgrade(
                self.hass, self.config_entry, preflight, _on_progress
            )
        job = self._job
        if self._upgrade_task is None:
            self._upgrade_task = self.hass.async_create_task(async_wait_flashed(job))
        if not self._upgrade_task.done():
            return self.async_show_progress(
                step_id="firmware_v3_flash",
                progress_action="firmware_v3_flash",
                description_placeholders={"version": preflight.release.tag},
                progress_task=self._upgrade_task,
            )
        self._upgrade_task = None
        if job.flashed.is_set():
            return self.async_show_progress_done(next_step_id="firmware_v3_migrate")
        err = job.task.exception() if not job.task.cancelled() else None
        if isinstance(err, UpgradeRefusedError):
            self._refusal = (
                err.reason,
                {**err.placeholders, "backup": str(preflight.backup)},
            )
        else:
            # The entry stays loaded on its 2.x data, so the upgrade can be
            # opened again to retry; the flash tolerates a display already
            # sitting in the AppLoader.
            self._refusal = flash_error_placeholders(
                err
                if isinstance(err, HomeAssistantError)
                else HomeAssistantError(str(err)),
                preflight,
            )
        return self.async_show_progress_done(next_step_id="firmware_v3_result")

    async def async_step_firmware_v3_migrate(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Wait for the display on 3.x, then write and verify its drive data."""
        from .firmware_v3 import UpgradeRefusedError, async_wait_done

        preflight, job = self._preflight, self._job
        assert preflight is not None
        assert job is not None
        if self._upgrade_task is None:
            self._upgrade_task = self.hass.async_create_task(async_wait_done(job))
        if not self._upgrade_task.done():
            return self.async_show_progress(
                step_id="firmware_v3_migrate",
                progress_action="firmware_v3_migrate",
                progress_task=self._upgrade_task,
            )
        self._upgrade_task = None
        err = job.task.exception() if not job.task.cancelled() else None
        if isinstance(err, UpgradeRefusedError):
            self._refusal = (err.reason, err.placeholders)
        elif err is not None:
            self._refusal = (
                "migrate_failed",
                {"error": str(err), "backup": str(preflight.backup)},
            )
        else:
            self._refusal = (
                "firmware_v3_done",
                {"version": preflight.release.tag, "backup": str(preflight.backup)},
            )
        return self.async_show_progress_done(next_step_id="firmware_v3_result")

    async def async_step_firmware_v3_result(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """End the upgrade with what happened."""
        reason, placeholders = self._refusal or ("unknown", {})
        return self.async_abort(
            reason=reason,
            description_placeholders={"name": self.config_entry.title, **placeholders},
        )

    def _drive_modes(self) -> list[str] | None:
        """Return the loaded display's drive modes (experimental ones only with the opt-in)."""
        runtime = getattr(self.config_entry, "runtime_data", None)
        config = getattr(runtime, "device_config", None)
        if config is None:
            return None
        return [
            mode.name
            for mode in selectable_modes(
                config, experimental_enabled(self.config_entry)
            )
        ]
