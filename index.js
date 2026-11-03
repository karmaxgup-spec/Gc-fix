// Group DMs — lets a "main character" privately message the user from a group chat.
// Works with Summaryception: its group-chat summaries are shared with the DM prompt.

import { updateMessageBlock } from '../../../../script.js';

const MODULE = 'group-dms';
const RULE_KEY = 'group_dms_rule';

// Settings panel markup lives here so the extension is just these JS/CSS files.
const SETTINGS_HTML = `
<div class="gdm-settings inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Group DMs</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <label class="checkbox_label"><input type="checkbox" id="gdm_enabled"> Enabled</label>
        <label>Main character
            <select id="gdm_main" class="text_pole"><option value="">(none)</option></select>
        </label>
        <label>Group summaries to share
            <input type="number" id="gdm_count" class="text_pole" min="1" max="20">
        </label>
        <label>DM note
            <textarea id="gdm_note" class="text_pole" rows="4"></textarea>
        </label>
        <button id="gdm_clear" class="menu_button">Clear DM history</button>
    </div>
</div>`;
const MAX_HISTORY = 40;
const DM_TAG = /\[DM:\s*([\s\S]+?)\]/g;

const defaults = Object.freeze({
    enabled: true,
    mainAvatar: '',
    summaryCount: 5,
    dmNote: 'You were recently talking with the user and your friends in a group chat. Summaries of that conversation are below. You may bring it up naturally in this private DM.',
    groupSummaries: {}, // { [groupId]: { name, members, summaries, updated } }
    dms: {},            // { [avatar]: [{ from: 'user'|'char', text, ts }] }
    unread: 0,
});

const ctx = () => SillyTavern.getContext();

function settings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(defaults);
    for (const k of Object.keys(defaults)) {
        if (!Object.hasOwn(extensionSettings[MODULE], k)) {
            extensionSettings[MODULE][k] = structuredClone(defaults[k]);
        }
    }
    return extensionSettings[MODULE];
}

const save = () => ctx().saveSettingsDebounced();
const esc = (t) => $('<div>').text(t).html();
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mainChar() {
    const { mainAvatar } = settings();
    return mainAvatar ? ctx().characters.find(c => c.avatar === mainAvatar) ?? null : null;
}

function currentGroup() {
    const c = ctx();
    return c.groupId ? c.groups.find(g => g.id === c.groupId) ?? null : null;
}

function dmThread(avatar) {
    const s = settings();
    if (!s.dms[avatar]) s.dms[avatar] = [];
    return s.dms[avatar];
}

function trimThread(avatar) {
    const t = dmThread(avatar);
    if (t.length > MAX_HISTORY) t.splice(0, t.length - MAX_HISTORY);
}

// ─── Summaryception bridge ───────────────────────────────────────────

// Copies the current group chat's Layer-0 summaries into settings so they
// survive switching chats and can be read while the DM is open.
function refreshGroupSummaries() {
    const group = currentGroup();
    if (!group) return;
    const layer0 = ctx().chatMetadata?.summaryception?.layers?.[0] ?? [];
    if (!layer0.length) return;
    const s = settings();
    s.groupSummaries[group.id] = {
        name: group.name,
        members: [...(group.members ?? [])],
        summaries: layer0.slice(-s.summaryCount).map(sn => sn.text),
        updated: Date.now(),
    };
    save();
}

let refreshTimer = null;
function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshGroupSummaries, 1500);
}

// Most recently updated group that includes this character.
function bestGroupFor(avatar) {
    return Object.values(settings().groupSummaries)
        .filter(g => g.members.includes(avatar) && g.summaries.length)
        .sort((a, b) => b.updated - a.updated)[0] ?? null;
}

// ─── Group-chat side: teach the main character the DM tag ─────────────

function applyDmRule() {
    const s = settings();
    const group = currentGroup();
    const main = mainChar();
    const active = s.enabled && group && main && group.members?.includes(main.avatar);
    ctx().setExtensionPrompt(RULE_KEY, active
        ? '[Private DM option: you may text the user privately, in addition to speaking in the group. To do so, write a line in the form [DM: your private message]. Use this rarely, only when you would really message them alone.]'
        : '', 0, 0);
}

// Strips [DM: ...] tags from any group reply; only the main character's are delivered.
function onCharacterRendered(messageId) {
    const s = settings();
    const c = ctx();
    const msg = c.chat[messageId];
    if (!s.enabled || !msg || msg.is_user || !msg.mes || !currentGroup()) return;
    const found = [...msg.mes.matchAll(DM_TAG)].map(m => m[1].trim()).filter(Boolean);
    if (!found.length) return;

    msg.mes = msg.mes.replace(DM_TAG, '').replace(/\n{3,}/g, '\n\n').trim();
    updateMessageBlock(messageId, msg);
    c.saveChat();

    const main = mainChar();
    const isMain = main && (msg.original_avatar === main.avatar || msg.name === main.name);
    if (!isMain) return;

    const thread = dmThread(main.avatar);
    for (const text of found) thread.push({ from: 'char', text, ts: Date.now() });
    trimThread(main.avatar);
    if (!panelOpenFor(main.avatar)) s.unread += found.length;
    save();
    renderPanel();
    toastr.info(`${main.name} sent you a DM`, 'Group DMs');
}

// ─── DM side: generate a reply without touching the group chat ───────

function buildSystemPrompt(main, group) {
    const memory = group
        ? `${settings().dmNote}\nGroup chat: "${group.name}"\n${group.summaries.join(' ')}`
        : '';
    return [
        `You are ${main.name}, texting the user privately.`,
        main.description,
        main.personality,
        main.scenario ? `Scenario: ${main.scenario}` : '',
        memory ? `<group_chat_memory>\n${memory}\n</group_chat_memory>` : '',
        `Write only ${main.name}'s next private text message. Keep it short and casual, DM-style. No narration, no name prefix.`,
    ].filter(Boolean).join('\n\n');
}

function buildTranscript(main, thread) {
    const user = ctx().name1;
    return thread
        .map(m => `${m.from === 'user' ? user : main.name}: ${m.text}`)
        .join('\n');
}

let busy = false;
async function sendDm(text) {
    const main = mainChar();
    if (!main) return toastr.warning('Pick a main character in Group DMs settings first.');
    if (busy) return;

    if (currentGroup()) refreshGroupSummaries();
    const thread = dmThread(main.avatar);
    thread.push({ from: 'user', text, ts: Date.now() });
    trimThread(main.avatar);
    save();
    renderPanel();

    busy = true;
    renderPanel();
    try {
        const reply = await ctx().generateRaw({
            prompt: `${buildTranscript(main, thread)}\n${main.name}:`,
            systemPrompt: buildSystemPrompt(main, bestGroupFor(main.avatar)),
        });
        const clean = (reply ?? '')
            .replace(new RegExp(`^${escapeRe(main.name)}:\\s*`), '')
            .trim();
        if (clean) thread.push({ from: 'char', text: clean, ts: Date.now() });
        trimThread(main.avatar);
    } catch (e) {
        console.error('[Group DMs]', e);
        toastr.error(`DM failed: ${e.message ?? e}`);
    } finally {
        busy = false;
        save();
        renderPanel();
    }
}

// ─── UI ───────────────────────────────────────────────────────────────

let openAvatar = null;

function panelOpenFor(avatar) {
    return openAvatar === avatar && $('#gdm_panel').is(':visible');
}

function updateBadge() {
    const { unread } = settings();
    const main = mainChar();
    const $badge = $('#gdm_badge');
    $('#gdm_fab').toggle(!!main && settings().enabled);
    $badge.text(unread > 99 ? '99+' : unread).toggle(unread > 0);
}

function renderPanel() {
    const main = mainChar();
    if (!main || !openAvatar) return;
    $('#gdm_title').text(`💬 ${main.name}`);
    const $log = $('#gdm_log').empty();
    for (const m of dmThread(main.avatar)) {
        $log.append(`<div class="gdm-msg ${m.from}">${esc(m.text)}</div>`);
    }
    if (busy) $log.append(`<div class="gdm-busy">${esc(main.name)} is typing…</div>`);
    $log.scrollTop($log[0].scrollHeight);
}

function openPanel() {
    const main = mainChar();
    if (!main) return toastr.warning('Pick a main character in Group DMs settings first.');
    openAvatar = main.avatar;
    settings().unread = 0;
    save();
    if (currentGroup()) refreshGroupSummaries();
    $('#gdm_panel').show();
    updateBadge();
    renderPanel();
    $('#gdm_input').trigger('focus');
}

function buildUi() {
    $('body').append(`
        <button id="gdm_fab" class="gdm-fab" title="Private DMs" style="display:none">
            <i class="fa-solid fa-comment-dots"></i>
            <span id="gdm_badge" class="gdm-badge"></span>
        </button>
        <div id="gdm_panel" class="gdm-panel" style="display:none">
            <div class="gdm-head">
                <span id="gdm_title"></span>
                <button id="gdm_close" class="menu_button">✕</button>
            </div>
            <div id="gdm_log" class="gdm-log"></div>
            <form id="gdm_form" class="gdm-form">
                <input id="gdm_input" class="text_pole" type="text" placeholder="Message…" autocomplete="off">
                <button class="menu_button" type="submit">Send</button>
            </form>
        </div>`);

    $('#gdm_fab').on('click', () => $('#gdm_panel').is(':visible') ? $('#gdm_panel').hide() : openPanel());
    $('#gdm_close').on('click', () => $('#gdm_panel').hide());
    $('#gdm_form').on('submit', (e) => {
        e.preventDefault();
        const text = $('#gdm_input').val().trim();
        if (!text) return;
        $('#gdm_input').val('');
        sendDm(text);
    });
}

function refreshMainOptions() {
    const s = settings();
    const $sel = $('#gdm_main').empty().append('<option value="">(none)</option>');
    for (const c of ctx().characters) {
        $sel.append($('<option>').val(c.avatar).text(c.name));
    }
    $sel.val(s.mainAvatar);
}

function bindSettings() {
    const s = settings();
    $('#gdm_enabled').prop('checked', s.enabled).on('change', function () {
        settings().enabled = this.checked;
        save(); applyDmRule(); updateBadge();
    });
    $('#gdm_main').on('change', function () {
        settings().mainAvatar = this.value;
        save(); applyDmRule(); updateBadge();
    });
    $('#gdm_count').val(s.summaryCount).on('change', function () {
        settings().summaryCount = Math.max(1, Math.min(20, Number(this.value) || 5));
        save();
    });
    $('#gdm_note').val(s.dmNote).on('change', function () {
        settings().dmNote = this.value;
        save();
    });
    $('#gdm_clear').on('click', () => {
        const main = mainChar();
        if (!main) return;
        if (!confirm(`Delete all DMs with ${main.name}?`)) return;
        settings().dms[main.avatar] = [];
        settings().unread = 0;
        save(); renderPanel(); updateBadge();
    });
}

// ─── Init ─────────────────────────────────────────────────────────────

jQuery(async () => {
    const c = ctx();
    $('#extensions_settings2').append(SETTINGS_HTML);

    bindSettings();
    refreshMainOptions();
    buildUi();
    updateBadge();

    const { eventSource, eventTypes } = c;
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, scheduleRefresh);
    eventSource.on(eventTypes.GENERATION_ENDED, scheduleRefresh);
    eventSource.on(eventTypes.GENERATION_STARTED, applyDmRule);
    eventSource.on(eventTypes.GROUP_UPDATED, applyDmRule);
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        applyDmRule();
        scheduleRefresh();
        refreshMainOptions();
    });
    applyDmRule();
});
