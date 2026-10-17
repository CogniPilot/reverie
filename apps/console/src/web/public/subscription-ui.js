/* Named subscription accounts: launch selection, sign-in help and independent quota rows. */
const ADD_ACCOUNT_OPTION = '__add-account__';
const LOGIN_HELP_OPTION = '__login-help__';

Object.assign(CodemanApp.prototype, {
  subscriptionRequestFields(mode) {
    const id = localStorage.getItem(`codeman:account:${mode}`);
    const profile = this._subscriptionProfiles?.find((p) => p.id === id);
    if (!id) return {};
    if (profile && !profile.modes.includes(mode)) return {};
    // Keep a removed selection explicit so the backend refuses it instead of switching accounts.
    return { subscriptionProfileId: id };
  },

  withSubscriptionProfile(body) {
    if (body.customModel) return body;
    return { ...body, ...this.subscriptionRequestFields(body.mode || this.runMode) };
  },

  selectSubscriptionProfile(id) {
    const key = `codeman:account:${this.runMode}`;
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  },

  async refreshSubscriptionAccounts() {
    const container = document.getElementById('subscriptionProfileControls');
    if (!container) return;
    try {
      const response = await this._apiJson('/api/subscription-profiles');
      if (!response) throw new Error('Account profiles are unavailable');
      this._subscriptionProfiles = response.profiles;
      const profiles = response.profiles.filter((p) => p.modes.includes(this.runMode));
      container.hidden = profiles.length === 0;
      const select = document.getElementById('subscriptionProfileSelect');
      const selected = localStorage.getItem(`codeman:account:${this.runMode}`) || '';
      select.replaceChildren(new Option('Agent default', ''));
      for (const profile of profiles)
        select.append(
          new Option(`${profile.provider === 'anthropic' ? 'Claude' : 'Codex'} · ${profile.label}`, profile.id)
        );
      if (selected && !profiles.some((p) => p.id === selected))
        select.append(new Option('Account removed — choose another', selected));
      select.append(new Option('+ Add account…', ADD_ACCOUNT_OPTION), new Option('Sign-in help…', LOGIN_HELP_OPTION));
      select.value = selected;
      select.dataset.previous = selected;
    } catch {
      container.hidden = true;
    }
  },

  /** Trailing "action" options in the picker run their action, then the previous account is restored. */
  onSubscriptionProfileChange(select) {
    const value = select.value;
    if (value === ADD_ACCOUNT_OPTION || value === LOGIN_HELP_OPTION) {
      select.value = select.dataset.previous || '';
      if (value === ADD_ACCOUNT_OPTION) this.addSubscriptionAccount();
      else this.showSubscriptionLogin();
      return;
    }
    select.dataset.previous = value;
    this.selectSubscriptionProfile(value);
  },

  _subscriptionDialog(title) {
    document.getElementById('subscriptionAccountDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'subscriptionAccountDialog';
    dialog.className = 'subscription-account-dialog';
    const heading = document.createElement('h3');
    heading.textContent = title;
    dialog.append(heading);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    return dialog;
  },

  addSubscriptionAccount() {
    const dialog = this._subscriptionDialog('Add subscription account');
    const form = document.createElement('form');
    const label = document.createElement('input');
    label.required = true;
    label.maxLength = 64;
    label.placeholder = 'Account name, e.g. Work';
    label.setAttribute('aria-label', 'Account name');
    const provider = document.createElement('select');
    provider.setAttribute('aria-label', 'Provider');
    provider.append(new Option('Claude', 'anthropic'), new Option('ChatGPT / Codex', 'openai'));
    provider.value = this._subscriptionProfiles?.find((p) => p.modes.includes(this.runMode))?.provider || 'anthropic';
    const add = document.createElement('button');
    add.type = 'submit';
    add.textContent = 'Add account';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => dialog.close();
    const error = document.createElement('p');
    error.setAttribute('role', 'alert');
    form.append(label, provider, add, cancel, error);
    form.onsubmit = async (event) => {
      event.preventDefault();
      add.disabled = true;
      try {
        const result = await this._apiJson('/api/subscription-profiles', {
          method: 'POST',
          body: {
            label: label.value,
            provider: provider.value,
          },
        });
        if (!result) throw new Error('Could not add the account');
        await this.refreshSubscriptionAccounts();
        const profile = this._subscriptionProfiles?.find((p) => p.id === result.profile.id);
        if (profile?.modes.includes(this.runMode)) this.selectSubscriptionProfile(profile.id);
        dialog.close();
        await this.refreshSubscriptionAccounts();
        this.showSubscriptionLogin(result.profile.id);
      } catch (failure) {
        error.textContent = failure.message;
        add.disabled = false;
      }
    };
    dialog.append(form);
    dialog.showModal();
    label.focus();
  },

  showSubscriptionLogin(id) {
    const selected = id || localStorage.getItem(`codeman:account:${this.runMode}`);
    const profile = this._subscriptionProfiles?.find((p) => p.id === selected);
    if (!profile) {
      this.showToast('Choose an account first', 'info');
      return;
    }
    const dialog = this._subscriptionDialog(`Sign in: ${profile.label}`);
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const isDefault = profile.id.endsWith('-default');
    const instructions = document.createElement('p');
    instructions.textContent =
      'Run these commands in a terminal and sign in with the account named above. Start a new session after signing in; existing sessions keep their account.';
    const commands = document.createElement('pre');
    commands.textContent =
      profile.provider === 'anthropic'
        ? `${isDefault ? '' : `CLAUDE_CONFIG_DIR=${quote(profile.configDir)} `}claude\n# Inside Claude Code, use /login. OpenCode reuses this login.`
        : `${isDefault ? '' : `CODEX_HOME=${quote(profile.configDir)} `}codex login\n\n# Sign into the same account for OpenCode:\nXDG_DATA_HOME=${quote(profile.openCodeDataDir)} opencode auth login --provider openai --method 'ChatGPT Pro/Plus (headless)'`;
    const done = document.createElement('button');
    done.textContent = 'Done';
    done.onclick = () => {
      dialog.close();
      this.refreshSubscriptionUsage();
    };
    dialog.append(instructions, commands, done);
    dialog.showModal();
  },

  async refreshSubscriptionUsage() {
    try {
      this._onSessionStatusTelemetry(await this._apiJson('/api/subscription-profiles/usage'));
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  },

  _accountProviderName(account) {
    return account.provider === 'anthropic' ? 'Claude' : 'Codex';
  },

  _accountWindows(account) {
    const out = [];
    for (const [name, window] of [
      ['5h', account.usage?.fiveHour],
      ['7d', account.usage?.sevenDay],
    ]) {
      if (!window || !Number.isFinite(window.usedPercentage)) continue;
      out.push({ name, window, pct: Math.round(Math.min(100, Math.max(0, window.usedPercentage))) });
    }
    return out;
  },

  /** Ring, window name, value and meter for one usage window (numbers only go through innerHTML). */
  _accountWindowEl(name, pct) {
    const win = document.createElement('span');
    win.className = 'pu-win';
    const color = pct >= 85 ? 'pu-red' : pct >= 60 ? 'pu-yellow' : 'pu-green';
    win.innerHTML = `<span class="pu-ring ${color}" style="--pu:${pct}"></span><span class="pu-label">${name}</span><span class="pu-val ${color}">${pct}%</span><span class="pu-meter ${color}"><i style="width:${pct}%"></i></span>`;
    return win;
  },

  _accountStatusEl(account) {
    const status = document.createElement('span');
    status.className = 'pu-label';
    status.textContent = account.status === 'signed-out' ? 'sign in' : account.provider === 'anthropic' ? 'unknown' : 'unavailable';
    return status;
  },

  /** The account shown in the header: the one chosen for the run mode, else the busiest 5h, else the first. */
  primarySubscriptionAccount(accounts) {
    let id = null;
    try {
      id = localStorage.getItem(`codeman:account:${this.runMode}`);
    } catch {}
    const chosen = id && accounts.find((a) => a.id === id);
    if (chosen) return chosen;
    let best = null;
    let bestPct = -1;
    for (const account of accounts) {
      const five = account.usage?.fiveHour?.usedPercentage;
      if (Number.isFinite(five) && five > bestPct) {
        best = account;
        bestPct = five;
      }
    }
    return best || accounts[0];
  },

  renderSubscriptionUsage(chip, accounts) {
    this._usageAccounts = accounts;
    const wasOpen = !!this._accountMenu;
    chip.replaceChildren();
    const primary = this.primarySubscriptionAccount(accounts);
    const multi = accounts.length > 1;
    if (!primary) {
      chip.textContent = '-';
      this.closeAccountMenu();
      return;
    }
    const row = document.createElement('span');
    row.className = 'pu-row pu-summary';
    const label = document.createElement('span');
    label.className = 'pu-provider';
    const tag = document.createElement('span');
    tag.className = 'pu-tag';
    tag.textContent = primary.provider === 'anthropic' ? 'C' : 'X';
    const name = document.createElement('span');
    name.className = 'pu-name';
    name.textContent = primary.label;
    label.append(tag, name);
    row.append(label);
    const windows = this._accountWindows(primary);
    for (const w of windows) row.append(this._accountWindowEl(w.name, w.pct));
    if (!windows.length) row.append(this._accountStatusEl(primary));
    chip.append(row);
    if (multi) {
      const badge = document.createElement('span');
      badge.className = 'pu-more';
      badge.textContent = `+${accounts.length - 1}`;
      const caret = document.createElement('span');
      caret.className = 'pu-caret';
      caret.setAttribute('aria-hidden', 'true');
      caret.textContent = '▾';
      chip.append(badge, caret);
    }
    chip.classList.toggle('pu-has-menu', multi);
    if (multi) {
      chip.setAttribute('role', 'button');
      chip.tabIndex = 0;
      chip.setAttribute('aria-haspopup', 'menu');
      chip.setAttribute('aria-expanded', 'false');
      if (!chip._accountMenuBound) {
        chip._accountMenuBound = true;
        chip.addEventListener('click', () => this.toggleAccountMenu());
        chip.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this.toggleAccountMenu();
          }
        });
      }
    } else {
      for (const attr of ['role', 'tabindex', 'aria-haspopup', 'aria-expanded']) chip.removeAttribute(attr);
    }
    chip.title = accounts
      .map((account) => {
        const lines = this._accountWindows(account).map(
          (w) => `${w.name}: ${w.pct}% used; resets ${new Date(w.window.resetAt).toLocaleString()}`
        );
        return `${account.label}\n${lines.join('\n') || account.status}\nUpdated ${new Date(account.updatedAt).toLocaleString()}`;
      })
      .join('\n\n');
    if (!multi) this.closeAccountMenu();
    else if (wasOpen) this.openAccountMenu();
  },

  toggleAccountMenu() {
    if (this._accountMenu) this.closeAccountMenu();
    else this.openAccountMenu();
  },

  openAccountMenu() {
    const chip = document.getElementById('planUsageChip');
    const accounts = this._usageAccounts;
    if (!chip || !accounts || accounts.length < 2) return;
    if (!this._subscriptionProfiles) this.refreshSubscriptionAccounts?.();
    this._teardownAccountMenu();
    const menu = document.createElement('div');
    menu.className = 'pu-menu';
    menu.setAttribute('role', 'menu');
    const selected = localStorage.getItem(`codeman:account:${this.runMode}`);
    for (const account of accounts) {
      const item = document.createElement('div');
      item.className = 'pu-menu-row';
      item.setAttribute('role', 'group');
      const head = document.createElement('div');
      head.className = 'pu-menu-head';
      const title = document.createElement('span');
      title.className = 'pu-menu-title';
      title.textContent = `${this._accountProviderName(account)} · ${account.label}`;
      head.append(title);
      if (account.id === selected) {
        const current = document.createElement('span');
        current.className = 'pu-menu-current';
        current.textContent = `in use for ${this.runMode}`;
        head.append(current);
      }
      item.append(head);
      const windows = this._accountWindows(account);
      const usage = document.createElement('div');
      usage.className = 'pu-menu-usage';
      for (const w of windows) {
        const cell = document.createElement('span');
        cell.className = 'pu-menu-win';
        cell.append(this._accountWindowEl(w.name, w.pct));
        const reset = document.createElement('span');
        reset.className = 'pu-menu-reset';
        reset.textContent = Number.isFinite(Date.parse(w.window.resetAt))
          ? `resets ${new Date(w.window.resetAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
          : '';
        cell.append(reset);
        usage.append(cell);
      }
      if (!windows.length) usage.append(this._accountStatusEl(account));
      item.append(usage);
      const actions = document.createElement('div');
      actions.className = 'pu-menu-actions';
      const known = this._subscriptionProfiles?.find((p) => p.id === account.id);
      if (known?.modes.includes(this.runMode) && account.id !== selected) {
        const use = document.createElement('button');
        use.type = 'button';
        use.setAttribute('role', 'menuitem');
        use.textContent = `Use for new ${this.runMode} sessions`;
        use.onclick = (event) => {
          event.stopPropagation();
          this.selectSubscriptionProfile(account.id);
          this.refreshSubscriptionAccounts?.();
          this.renderSubscriptionUsage(chip, accounts);
        };
        actions.append(use);
      }
      const signIn = document.createElement('button');
      signIn.type = 'button';
      signIn.setAttribute('role', 'menuitem');
      if (account.status !== 'signed-out') signIn.className = 'pu-menu-link';
      signIn.textContent = account.status === 'signed-out' ? 'Sign in' : 'Sign in again';
      signIn.onclick = (event) => {
        event.stopPropagation();
        this.signInAccount?.(account.id, `${this._accountProviderName(account)} · ${account.label}`);
      };
      actions.append(signIn);
      const help = document.createElement('button');
      help.type = 'button';
      help.setAttribute('role', 'menuitem');
      help.className = 'pu-menu-link';
      help.textContent = 'Sign-in help';
      help.onclick = (event) => {
        event.stopPropagation();
        this.closeAccountMenu();
        this.showSubscriptionLogin(account.id);
      };
      actions.append(help);
      item.append(actions);
      menu.append(item);
    }
    const footer = document.createElement('div');
    footer.className = 'pu-menu-footer';
    const add = document.createElement('button');
    add.type = 'button';
    add.setAttribute('role', 'menuitem');
    add.textContent = 'Add account';
    add.onclick = (event) => {
      event.stopPropagation();
      this.closeAccountMenu();
      this.addSubscriptionAccount();
    };
    const plans = document.createElement('button');
    plans.type = 'button';
    plans.setAttribute('role', 'menuitem');
    plans.textContent = 'Plans\u2026';
    plans.title = 'Every account paced against its week, with the sessions on it';
    plans.onclick = (event) => {
      event.stopPropagation();
      this.closeAccountMenu();
      this.openPlans?.();
    };
    footer.append(plans, add);
    menu.append(footer);
    document.body.append(menu);
    const place = () => {
      const rect = chip.getBoundingClientRect();
      const width = menu.offsetWidth;
      menu.style.top = `${Math.round(rect.bottom + 6)}px`;
      menu.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)))}px`;
    };
    place();
    const onPointer = (event) => {
      if (!menu.contains(event.target) && !chip.contains(event.target)) this.closeAccountMenu();
    };
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', place);
    this._accountMenu = menu;
    this._accountMenuCleanup = () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', place);
    };
    chip.setAttribute('aria-expanded', 'true');
  },

  _teardownAccountMenu() {
    this._accountMenuCleanup?.();
    this._accountMenuCleanup = null;
    this._accountMenu?.remove();
    this._accountMenu = null;
  },

  /** No-op when closed: the global Escape handler may call it unconditionally. */
  closeAccountMenu() {
    if (!this._accountMenu) return false;
    this._teardownAccountMenu();
    const chip = document.getElementById('planUsageChip');
    chip?.setAttribute('aria-expanded', 'false');
    return true;
  },
});
