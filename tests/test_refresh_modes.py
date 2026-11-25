"""Test refresh (drive) modes: the mode field and default option, the plan, inline tables and the preset repair."""

from collections import Counter
from collections.abc import Generator
import dataclasses
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.components.repairs import DOMAIN as REPAIRS_DOMAIN
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import (
    device_registry as dr,
    entity_registry as er,
    issue_registry as ir,
)
from homeassistant.setup import async_setup_component
from opendisplay import ColorScheme, GlobalConfig, InvalidResponseError
from opendisplay.models.ident import FirmwareTarget
from opendisplay.models.lut_assemble import assemble_subset_s6
from opendisplay.models.panel_drive import LengthPrefixedPacket
from opendisplay.panels import MigrationPlan, TargetClass
from opendisplay.panels.preset_update import PresetKind, PresetUpdate, PresetUpdatePlan
from PIL import Image as PILImage
import pytest
from pytest_homeassistant.common import MockConfigEntry
from pytest_homeassistant.components.repairs import (
    process_repair_fix_flow,
    start_repair_fix_flow,
)
from pytest_homeassistant.typing import ClientSessionGenerator

from custom_components.opendisplay.const import (
    CONF_DEFAULT_DRIVE_MODE,
    CONF_EXPERIMENTAL_MODES,
    DOMAIN,
)
from custom_components.opendisplay.refresh_modes import RefreshModeError, inline_tables
from custom_components.opendisplay.repairs import preset_update_issue_id

from . import DEVICE_CONFIG, TEST_ADDRESS

_REPAIRS = "custom_components.opendisplay.repairs"
_PACKETS = json.loads(
    (Path(__file__).parent / "fixtures" / "s73_drive_packets.json").read_text()
)["packets"]

STOCK_NAMES = ["full", "fast"]
ALL_NAMES = [
    "full",
    "fast",
    "full_quick",
    "faster_cool",
    "faster_warm",
    "partialcool",
    "adaptive",
]


def _s73_config(drop: tuple[str, ...] = ()) -> GlobalConfig:
    """DEVICE_CONFIG with the 7.3in Spectra 6 drive packets (modes ``drop`` left out)."""
    counts: Counter[int] = Counter()
    packets: list[LengthPrefixedPacket] = []
    for raw in _PACKETS:
        body = bytes.fromhex(raw["body_hex"])
        if raw["id"] == 0xAE and any(
            body[2:].split(b"\x00", 1)[0] == name.encode() for name in drop
        ):
            continue
        packets.append(
            LengthPrefixedPacket(
                number=counts[raw["id"]], packet_type=raw["id"], body=body
            )
        )
        counts[raw["id"]] += 1
    display = dataclasses.replace(
        DEVICE_CONFIG.displays[0], color_scheme=ColorScheme.BWGBRY.value
    )
    return dataclasses.replace(
        DEVICE_CONFIG, displays=[display], length_prefixed_packets=packets
    )


S73 = _s73_config()


@pytest.fixture
def device_config() -> GlobalConfig:
    """Report the 7.3in Spectra 6 config with its refresh modes."""
    return S73


@pytest.fixture
def experimental() -> bool:
    """Whether the entry opts in to experimental modes."""
    return True


@pytest.fixture
def config_entry_options(experimental: bool) -> dict[str, Any]:
    """Opt in (or not) to experimental refresh modes."""
    return {CONF_EXPERIMENTAL_MODES: experimental}


@pytest.fixture
def show(mock_opendisplay_connect: MagicMock) -> AsyncMock:
    """Mock Device.display.show; the panel reports 27 C."""
    connected = mock_opendisplay_connect.return_value
    connected.display.show = AsyncMock(return_value=27)
    connected.profile.target = FirmwareTarget.NRF52840
    return connected.display.show


@pytest.fixture(autouse=True)
def mock_resolve_media(tmp_path: Path) -> Generator[MagicMock]:
    """Resolve media to a small local image."""
    image_path = tmp_path / "test.png"
    PILImage.new("RGB", (296, 128), (200, 30, 30)).save(image_path)
    media = MagicMock()
    media.path = image_path
    with patch(
        "custom_components.opendisplay.services.async_resolve_media",
        return_value=media,
    ):
        yield media


async def _setup(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


def _device_id(hass: HomeAssistant) -> str:
    registry = dr.async_get(hass)
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    devices = dr.async_entries_for_config_entry(registry, entry.entry_id)
    assert devices
    return devices[0].id


def _sensor_entity(hass: HomeAssistant) -> str:
    entity_id = er.async_get(hass).async_get_entity_id(
        "sensor", DOMAIN, f"{TEST_ADDRESS}-last_refresh_mode"
    )
    assert entity_id is not None
    return entity_id


async def _upload(hass: HomeAssistant, **extra: Any) -> None:
    await hass.services.async_call(
        DOMAIN,
        "upload_image",
        {
            "device_id": _device_id(hass),
            "image": {
                "media_content_id": "media-source://local/test.png",
                "media_content_type": "image/png",
            },
            **extra,
        },
        blocking=True,
    )
    await hass.async_block_till_done()


async def _set_default(hass: HomeAssistant, option: str) -> None:
    """Set the default-drive-mode option (as the options flow would, without its reload)."""
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, CONF_DEFAULT_DRIVE_MODE: option}
    )


def _shown_modes(show: AsyncMock) -> list[str]:
    return [call.kwargs["mode"] for call in show.await_args_list]


# -- option filtering ----------------------------------------------------------


@pytest.mark.parametrize(
    ("experimental", "names"), [(False, STOCK_NAMES), (True, ALL_NAMES)]
)
async def test_experimental_modes_are_offered_only_with_the_opt_in(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, names: list[str]
) -> None:
    """The sensor lists the stock modes, and the experimental ones after the opt-in."""
    await _setup(hass, mock_config_entry)

    state = hass.states.get(_sensor_entity(hass))
    assert state is not None
    assert list(state.attributes["available_modes"]) == names


@pytest.mark.parametrize("experimental", [False])
async def test_an_experimental_mode_is_refused_without_the_opt_in(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, show: AsyncMock
) -> None:
    """A service call naming an experimental mode is refused before any upload."""
    await _setup(hass, mock_config_entry)

    with pytest.raises(ServiceValidationError) as err:
        await _upload(hass, mode="faster_cool")

    assert err.value.translation_key == "refresh_mode_experimental"
    show.assert_not_awaited()


async def test_an_unknown_mode_is_refused(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, show: AsyncMock
) -> None:
    """A mode the config does not declare is a validation error naming the modes."""
    await _setup(hass, mock_config_entry)

    with pytest.raises(ServiceValidationError) as err:
        await _upload(hass, mode="turbo")

    assert err.value.translation_key == "refresh_mode_unknown"
    show.assert_not_awaited()


async def test_a_display_without_drive_modes_has_no_sensor(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    mock_opendisplay_device: MagicMock,
) -> None:
    """No 0xAE modes: no sensor, and uploads stay on the plain path."""
    mock_opendisplay_device.config = DEVICE_CONFIG
    await _setup(hass, mock_config_entry)

    registry = er.async_get(hass)
    assert (
        registry.async_get_entity_id(
            "sensor", DOMAIN, f"{TEST_ADDRESS}-last_refresh_mode"
        )
        is None
    )
    await _upload(hass)
    mock_opendisplay_device.upload_prepared_image.assert_awaited_once()


# -- plain path for stock modes --------------------------------------------------


@pytest.mark.parametrize("experimental", [False])
async def test_the_stock_mode_uses_the_plain_upload_and_resets_the_budget(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    mock_opendisplay_device: MagicMock,
    show: AsyncMock,
) -> None:
    """Without the opt-in, mode 0 goes through upload_prepared_image as a stock drive."""
    await _setup(hass, mock_config_entry)

    await _upload(hass)

    mock_opendisplay_device.upload_prepared_image.assert_awaited_once()
    show.assert_not_awaited()
    sensor = hass.states.get(_sensor_entity(hass))
    assert sensor is not None
    assert sensor.state == "full"
    assert sensor.attributes["budget_used"] == 0


async def test_a_stock_full_keeps_its_frame_for_the_next_hold_code_mode(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    mock_opendisplay_connect: MagicMock,
    mock_opendisplay_device: MagicMock,
    show: AsyncMock,
) -> None:
    """With the opt-in and a hold-code mode, a full is a drive write whose frame is the prior."""
    display = mock_opendisplay_connect.return_value.display
    display.last_frame = b"\x11" * 16
    display.last_etag = 0x1234
    display.last_changed = None
    await _setup(hass, mock_config_entry)

    await _upload(hass, mode="full")
    await _upload(hass, mode="partialcool")

    mock_opendisplay_device.upload_prepared_image.assert_not_awaited()
    assert _shown_modes(show) == ["full", "partialcool"]
    assert show.await_args_list[0].kwargs["prior"] is None
    assert show.await_args_list[1].kwargs["prior"] == b"\x11" * 16
    assert show.await_args_list[1].kwargs["prior_etag"] == 0x1234


async def test_a_full_with_tone_compression_stays_plain(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    mock_opendisplay_device: MagicMock,
    show: AsyncMock,
) -> None:
    """The drive write cannot honour tone compression, so such a full stays a plain upload."""
    await _setup(hass, mock_config_entry)

    await _upload(hass, mode="full", tone_compression=0.5)

    mock_opendisplay_device.upload_prepared_image.assert_awaited_once()
    show.assert_not_awaited()


async def test_the_fast_mode_uses_the_fast_refresh(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    mock_opendisplay_device: MagicMock,
    show: AsyncMock,
) -> None:
    """A default mode "fast" sends the plain upload with the fast refresh."""
    await _setup(hass, mock_config_entry)
    await _set_default(hass, "fast")

    await _upload(hass)

    call = mock_opendisplay_device.upload_prepared_image.await_args
    assert call.kwargs["refresh_mode"].name == "FAST"
    show.assert_not_awaited()


# -- planner: stock full first, band substitution, persistence -------------------


async def test_the_plan_inserts_a_stock_full_and_switches_band(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    show: AsyncMock,
    hass_storage: dict[str, Any],
) -> None:
    """No state: a stock full comes first; at 27 C the band-7 variant runs instead."""
    await _setup(hass, mock_config_entry)
    await _set_default(hass, "faster_cool")

    # No drive state and no temperature yet: stock full, then the requested band.
    await _upload(hass)
    assert _shown_modes(show) == ["full", "faster_cool"]

    # The ACK said 27 C, which is in faster_warm's window: band change, so a stock full first.
    show.reset_mock()
    await _upload(hass)
    assert _shown_modes(show) == ["full", "faster_warm"]

    sensor = hass.states.get(_sensor_entity(hass))
    assert sensor is not None
    assert sensor.state == "faster_warm"
    assert sensor.attributes["requested"] == "faster_cool"
    assert sensor.attributes["substituted"] is True
    assert sensor.attributes["stock_full_first"] is True
    assert sensor.attributes["temp_c"] == 27
    assert sensor.attributes["budget_used"] == 1
    assert sensor.attributes["budget_limit"] == 10

    # Same band again: no stock full, the budget grows.
    show.reset_mock()
    await _upload(hass)
    assert _shown_modes(show) == ["faster_warm"]
    sensor = hass.states.get(_sensor_entity(hass))
    assert sensor is not None
    assert sensor.attributes["chosen"] == "faster_warm"
    assert sensor.attributes["budget_used"] == 2

    # The default and the drive state survive a reload.
    assert await hass.config_entries.async_unload(mock_config_entry.entry_id)
    assert mock_config_entry.options[CONF_DEFAULT_DRIVE_MODE] == "faster_cool"
    stored = hass_storage[f"{DOMAIN}.refresh_modes.{mock_config_entry.entry_id}"]
    record = stored["data"]["devices"][TEST_ADDRESS]
    assert record["budget_used"] == 2
    assert record["last_band"] == 2  # warm
    assert record["last_temp_c"] == 27

    assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done()
    show.reset_mock()
    await _upload(hass)
    assert _shown_modes(show) == ["faster_warm"]


async def test_the_budget_forces_a_stock_full(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    show: AsyncMock,
) -> None:
    """Once the 0xB1 budget (10) would run over, a stock full is inserted."""
    await _setup(hass, mock_config_entry)
    for _ in range(10):
        await _upload(hass, mode="faster_warm")
    show.reset_mock()

    # 10 budget units spent since the last stock full: the next one resets.
    await _upload(hass, mode="faster_warm")

    assert _shown_modes(show) == ["full", "faster_warm"]
    sensor = hass.states.get(_sensor_entity(hass))
    assert sensor is not None
    assert "budget" in sensor.attributes["reasons"][0]


async def test_a_device_substituting_stock_draws_stock(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    show: AsyncMock,
) -> None:
    """The device's window check runs mode 0: the image is drawn again in stock, with a note."""
    from opendisplay import DriveModeSubstitutedError

    await _setup(hass, mock_config_entry)
    await _upload(hass, mode="full")
    show.reset_mock()
    show.side_effect = [DriveModeSubstitutedError("full_quick", 0, 31), 31]

    await _upload(hass, mode="full_quick")

    assert _shown_modes(show) == ["full_quick", "full"]
    sensor = hass.states.get(_sensor_entity(hass))
    assert sensor is not None
    assert sensor.attributes["substituted"] is True
    assert any("outside the window" in n for n in sensor.attributes["notes"])


async def test_a_device_substituting_another_mode_is_a_clear_error(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    show: AsyncMock,
) -> None:
    """A substitution to anything but the stock full surfaces as an error naming both modes."""
    from opendisplay import DriveModeSubstitutedError

    await _setup(hass, mock_config_entry)
    show.side_effect = DriveModeSubstitutedError("full_quick", 3, 30)

    with pytest.raises(HomeAssistantError, match="instead of 'full_quick'"):
        await _upload(hass, mode="full_quick")


# -- inline tables ---------------------------------------------------------------


async def test_hosttable_sends_its_table_inline(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    show: AsyncMock,
) -> None:
    """Every adaptive upload carries slot 5, built from faster_cool's table for the frame's codes."""
    await _setup(hass, mock_config_entry)

    await _upload(hass, mode="adaptive")

    assert _shown_modes(show) == ["full", "adaptive"]
    stock, host = show.await_args_list
    assert stock.kwargs["inline_luts"] is None
    tables = host.kwargs["inline_luts"]
    assert list(tables) == [5]
    source = next(lut for lut in S73.display_luts if lut.slot_id == 2).waveform
    # A red image dithers to red (code 3) with white/black neighbours at most.
    built = tables[5]
    assert len(built) == 800
    assert built[:96] == source[:96]
    assert built in {
        assemble_subset_s6(source, codes)
        for codes in ({3}, {0, 3}, {1, 3}, {0, 1, 3}, {0, 1, 2, 3}, {0, 1, 2, 3, 5, 6})
    }

    # And again on the next upload (the table is never stored).
    show.reset_mock()
    await _upload(hass, mode="adaptive")
    assert _shown_modes(show) == ["adaptive"]
    assert list(show.await_args.kwargs["inline_luts"]) == [5]


def test_inline_tables_are_built_only_for_modes_that_need_them() -> None:
    """Stored slots need nothing inline; adaptive needs codes and faster_cool's table."""
    modes = {m.name: m for m in S73.display_modes}
    assert inline_tables(S73, modes["faster_cool"], None) is None
    with pytest.raises(RefreshModeError, match="codes are unknown"):
        inline_tables(S73, modes["adaptive"], None)
    no_source = _s73_config(drop=("faster_cool",))
    host = next(m for m in no_source.display_modes if m.name == "adaptive")
    with pytest.raises(RefreshModeError, match="'faster_cool'"):
        inline_tables(no_source, host, frozenset({0, 1}))


async def test_inline_tables_are_refused_on_bg22(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    mock_opendisplay_connect: MagicMock,
    show: AsyncMock,
) -> None:
    """A target without INLINE_LUT gets a clear error before anything is driven."""
    await _setup(hass, mock_config_entry)
    mock_opendisplay_connect.return_value.profile.target = FirmwareTarget.EFR32BG22

    with pytest.raises(HomeAssistantError, match="INLINE_LUT"):
        await _upload(hass, mode="adaptive")

    show.assert_not_awaited()


async def test_an_inline_nack_is_a_clear_error(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    show: AsyncMock,
) -> None:
    """A device that NACKs the inline START (0x05) surfaces as an INLINE_LUT error."""
    await _setup(hass, mock_config_entry)
    await _upload(hass, mode="faster_cool")  # consume the stock full
    show.reset_mock()
    show.side_effect = InvalidResponseError(
        "Drive write START for mode 8 refused: 0x05 (unsupported on this target)"
    )

    with pytest.raises(HomeAssistantError, match="does not accept INLINE_LUT"):
        await _upload(hass, mode="adaptive")


# -- preset-update repair --------------------------------------------------------


_FAST6 = next(
    p
    for p in S73.length_prefixed_packets
    if p.packet_type == 0xAE and p.body[2:].startswith(b"faster_cool\x00")
)


def _preset_plan(**drive_changes: Any) -> PresetUpdatePlan:
    drive = MigrationPlan(
        needed=True,
        blocked=False,
        reason="drive preset 0x0023 rev 1 -> 2",
        panel_ic_type=0x0023,
        target_class=TargetClass.DEFAULT,
        add=(_FAST6,),
        remove=tuple(p for p in S73.length_prefixed_packets if p.packet_type == 0xAE),
    )
    drive = dataclasses.replace(drive, **drive_changes)
    update = PresetUpdate(PresetKind.DRIVE, 0x0023, 1, 2, "faster faster_cool", True)
    return PresetUpdatePlan(updates=(update,), drive=drive)


@pytest.fixture
def preset_plan() -> Generator[MagicMock]:
    """Make the bundle offer a drive update for the display."""
    with patch(f"{_REPAIRS}.plan_preset_update", return_value=_preset_plan()) as plan:
        yield plan


async def test_a_newer_preset_raises_a_fixable_issue(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    issue_registry: ir.IssueRegistry,
    preset_plan: MagicMock,
) -> None:
    """Setup raises the issue, planned with the entry's experimental opt-in."""
    await _setup(hass, mock_config_entry)

    issue = issue_registry.async_get_issue(
        DOMAIN, preset_update_issue_id(mock_config_entry)
    )
    assert issue is not None
    assert issue.is_fixable
    assert issue.translation_placeholders["bundle_rev"] == "2"
    assert preset_plan.call_args.kwargs["include_experimental"] is True


async def test_no_newer_preset_removes_the_issue(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    issue_registry: ir.IssueRegistry,
) -> None:
    """A device already at the bundle's revision has no issue."""
    ir.async_create_issue(
        hass,
        DOMAIN,
        preset_update_issue_id(mock_config_entry),
        is_fixable=True,
        severity=ir.IssueSeverity.WARNING,
        translation_key="preset_update",
    )
    with patch(f"{_REPAIRS}.plan_preset_update", return_value=PresetUpdatePlan()):
        await _setup(hass, mock_config_entry)

    assert (
        issue_registry.async_get_issue(
            DOMAIN, preset_update_issue_id(mock_config_entry)
        )
        is None
    )


async def test_the_preset_fix_writes_the_drive_update_and_reloads(
    hass: HomeAssistant,
    hass_client: ClientSessionGenerator,
    mock_config_entry: MockConfigEntry,
    issue_registry: ir.IssueRegistry,
    preset_plan: MagicMock,
) -> None:
    """The user confirms; the drive update is written after a backup and the issue goes."""
    await _setup(hass, mock_config_entry)
    assert await async_setup_component(hass, REPAIRS_DOMAIN, {})
    issue_id = preset_update_issue_id(mock_config_entry)

    with (
        patch(f"{_REPAIRS}._write_backup", return_value=Path("b.json")) as backup,
        patch(f"{_REPAIRS}.write_and_verify", AsyncMock(return_value=False)) as write,
        patch.object(hass.config_entries, "async_schedule_reload") as reload,
    ):
        client = await hass_client()
        flow = await start_repair_fix_flow(client, DOMAIN, issue_id)
        assert flow["step_id"] == "confirm"
        assert flow["description_placeholders"]["changelog"] == "faster faster_cool"
        assert flow["description_placeholders"]["panel"] == "0x0023"

        flow = await process_repair_fix_flow(client, flow["flow_id"])

    assert flow["type"] == "create_entry"
    backup.assert_called_once()
    written = write.await_args.args[1]
    assert written.security_config == S73.security_config
    assert [
        p.body for p in written.length_prefixed_packets if p.packet_type == 0xAE
    ] == [_FAST6.body]
    reload.assert_called_once_with(mock_config_entry.entry_id)
    assert issue_registry.async_get_issue(DOMAIN, issue_id) is None


async def test_the_preset_fix_never_touches_other_packets(
    hass: HomeAssistant,
    hass_client: ClientSessionGenerator,
    mock_config_entry: MockConfigEntry,
    issue_registry: ir.IssueRegistry,
    preset_plan: MagicMock,
) -> None:
    """A plan that would change a non-drive packet is refused; nothing is written."""
    await _setup(hass, mock_config_entry)
    assert await async_setup_component(hass, REPAIRS_DOMAIN, {})
    preset_plan.return_value = _preset_plan(
        add=(LengthPrefixedPacket(number=0, packet_type=0x27, body=b"\x00"),)
    )

    with (
        patch(f"{_REPAIRS}._write_backup") as backup,
        patch(f"{_REPAIRS}.write_and_verify", AsyncMock()) as write,
    ):
        client = await hass_client()
        flow = await start_repair_fix_flow(
            client, DOMAIN, preset_update_issue_id(mock_config_entry)
        )
        flow = await process_repair_fix_flow(client, flow["flow_id"])

    assert flow["errors"] == {"base": "write_failed"}
    backup.assert_not_called()
    write.assert_not_awaited()
    assert issue_registry.async_get_issue(
        DOMAIN, preset_update_issue_id(mock_config_entry)
    )


async def test_the_preset_fix_resolves_when_the_update_is_gone(
    hass: HomeAssistant,
    hass_client: ClientSessionGenerator,
    mock_config_entry: MockConfigEntry,
    issue_registry: ir.IssueRegistry,
    preset_plan: MagicMock,
) -> None:
    """Opening the repair after the update was written elsewhere just resolves it."""
    await _setup(hass, mock_config_entry)
    assert await async_setup_component(hass, REPAIRS_DOMAIN, {})
    preset_plan.return_value = PresetUpdatePlan()

    client = await hass_client()
    flow = await start_repair_fix_flow(
        client, DOMAIN, preset_update_issue_id(mock_config_entry)
    )

    assert flow["type"] == "create_entry"
    assert (
        issue_registry.async_get_issue(
            DOMAIN, preset_update_issue_id(mock_config_entry)
        )
        is None
    )


# -- the removed select: migration; plain names ------------------------------------


async def test_the_old_select_becomes_the_default_option(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    hass_storage: dict[str, Any],
) -> None:
    """A stored select choice moves into the option and the orphaned entity goes."""
    hass_storage[f"{DOMAIN}.refresh_modes.{mock_config_entry.entry_id}"] = {
        "version": 1,
        "key": f"{DOMAIN}.refresh_modes.{mock_config_entry.entry_id}",
        "data": {"selected": "fast", "devices": {}, "last_run": None, "priors": {}},
    }
    mock_config_entry.add_to_hass(hass)
    registry = er.async_get(hass)
    registry.async_get_or_create(
        "select", DOMAIN, f"{TEST_ADDRESS}-refresh_mode", config_entry=mock_config_entry
    )
    assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done()

    assert mock_config_entry.options[CONF_DEFAULT_DRIVE_MODE] == "fast"
    assert (
        registry.async_get_entity_id("select", DOMAIN, f"{TEST_ADDRESS}-refresh_mode")
        is None
    )


async def test_mode_partial_is_the_plain_partial_refresh(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    mock_opendisplay_device: MagicMock,
    show: AsyncMock,
) -> None:
    """mode: partial (not a declared drive mode) is the plain upload's partial refresh."""
    await _setup(hass, mock_config_entry)
    await _set_default(hass, "faster_cool")

    await _upload(hass, mode="partial")

    show.assert_not_awaited()
    call = mock_opendisplay_device.upload_prepared_image.await_args
    assert call is not None
    assert call.kwargs["refresh_mode"].name == "PARTIAL"


@pytest.mark.parametrize("experimental", [True])
async def test_test_modes_are_callable_but_not_listed(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, show: AsyncMock
) -> None:
    """test_* modes stay out of available_modes, and a call can still name one."""
    await _setup(hass, mock_config_entry)

    state = hass.states.get(_sensor_entity(hass))
    assert state is not None
    assert not any(
        name.startswith("test_") for name in state.attributes["available_modes"]
    )
    await _upload(hass, mode="test_cool")
    assert _shown_modes(show)[-1] == "test_cool"
