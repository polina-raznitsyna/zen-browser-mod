/*
 * Правки поведения боковой панели, не связанные с перетаскиванием:
 * свёрнутые папки и закреплённые, число колонок в сетке закреплённых,
 * подсказка у крестика, автопрокрутка списка и жест перелистывания
 * пространств. Каждая включается своей настройкой и проверяет её в момент
 * срабатывания.
 *
 * Сверено с исходниками Zen 1.24.3b: ZenFolders.mjs, ZenFolder.mjs,
 * ZenSpace.mjs, ZenSpacesSwipe.mjs, ZenSpaceManager.mjs.
 */
(() => {
  "use strict";

  const PREF_COLLAPSE_HIDES_ALL = "mod.zbm.folders.collapse-hides-all";
  const PREF_NO_AUTOSCROLL = "mod.zbm.sidebar.no-autoscroll-on-space-switch";
  const PREF_SWIPE = "mod.zbm.swipe.easier";
  const PREF_SWIPE_THRESHOLD = "mod.zbm.swipe.threshold";
  const PREF_SWIPE_VELOCITY = "mod.zbm.swipe.velocity";
  const PREF_PINS_GRID = "mod.zbm.pins.grid";
  const PREF_MAX_THREE = "mod.zbm.tiles.max-three";
  const PREF_UNLOAD_HIDE = "mod.zbm.unload.hide";
  const PREF_ZEN_CLOSE_BEHAVIOR = "zen.pinned-tab-manager.close-shortcut-behavior";

  // Zen анимирует папку около 180 мс. Свою правку начинаем после него,
  // чтобы две анимации одной папки не шли одновременно.
  const FOLDER_SETTLE_MS = 350;
  // Столько же длится сворачивание папок в Zen.
  const PINS_ANIMATION_MS = 180;

  const root = document.documentElement;

  const getPref = name => Services.prefs.getBoolPref(name, false);
  const getNumber = (name, fallback) => {
    const value = Number(Services.prefs.getStringPref(name, ""));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  let disposed = false;
  let readyTimer = null;
  const cleanups = [];
  const listen = (target, type, handler, capture = false) => {
    target.addEventListener(type, handler, capture);
    cleanups.push(() => target.removeEventListener(type, handler, capture));
  };

  /*
   * Свёрнутая папка прячет все вкладки.
   *
   * Zen оставляет под свёрнутой папкой вкладку, которая была активной, и
   * убирает её только при выгрузке. Здесь при сворачивании уходит и активная,
   * а вкладка, показанная позже, уходит внутрь, как только с неё ушёл фокус.
   * То же для закреплённых вкладок пространства, свёрнутых кликом по его
   * названию: для Zen это такая же папка. Вкладки при этом не выгружаются.
   *
   * Смена пространства папки не трогает: вкладка, спрятанная в свёрнутую
   * папку, не достаётся наружу оттого, что пространство снова открыли, а
   * показанная не прячется оттого, что из него ушли.
   */
  const folderOf = tab =>
    tab.group?.hasAttribute("split-view-group") ? tab.group.group : tab.group;

  const isCollapsiblePins = group =>
    group?.localName === "zen-workspace-collapsible-pins";

  /**
   * Папка, под которой вкладка сейчас показана как активная. Для вкладки в
   * раскрытой папке внутри свёрнутых закреплённых это сами закреплённые:
   * в цепочке папок вкладки Zen их не держит.
   */
  function activeOwner(tab) {
    const folder = folderOf(tab);
    if (folder?.isZenFolder && folder.activeGroups?.length) {
      return folder;
    }
    const pins = window.gZenWorkspaces?.workspaceElement?.(
      tab.getAttribute("zen-workspace-id")
    )?.collapsiblePins;
    const inPins = tab.pinned && !tab.hasAttribute("zen-essential");
    return inPins && pins?.collapsed && pins.hasAttribute("has-active") ? pins : null;
  }

  /** Убирает внутрь вкладки, оставшиеся на виду под свёрнутыми папками, кроме выбранной. */
  async function hideIntoFolders() {
    const tabs = [...document.querySelectorAll(".tabbrowser-tab[folder-active]")];
    for (const tab of tabs) {
      // Пока шла предыдущая анимация, всё могло поменяться: проверяем заново.
      if (disposed || !getPref(PREF_COLLAPSE_HIDES_ALL)) {
        return;
      }
      if (
        !tab.isConnected ||
        !tab.hasAttribute("folder-active") ||
        tab.selected ||
        tab.multiselected ||
        // Другие пространства остаются такими, какими их оставили.
        tab.getAttribute("zen-workspace-id") !== gZenWorkspaces.activeWorkspace
      ) {
        continue;
      }
      const owner = activeOwner(tab);
      if (owner) {
        await gZenFolders.animateUnload(owner, tab);
      }
    }
  }

  const changingSpace = () => !!window.gZenWorkspaces?.isChangingWorkspace;

  let hideTimer = null;
  function scheduleHide() {
    if (changingSpace()) {
      return;
    }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      hideIntoFolders().catch(error =>
        console.error("[zen-browser-mod] hiding folder tab failed:", error)
      );
    }, FOLDER_SETTLE_MS);
  }

  /**
   * На время вызова делает так, что Zen не видит в папке выбранных вкладок.
   * Какие вкладки оставить на виду, animateCollapse решает в самом начале, до
   * первой паузы, по tab.selected и tab.multiselected. Без них он сворачивает
   * папку целиком одной анимацией, как папку без активных вкладок.
   *
   * @returns {Function} Возвращает вкладкам настоящие свойства.
   */
  function pretendNothingSelected(group) {
    const shadowed = [];
    const container = group.groupContainer;
    for (const tab of container?.querySelectorAll(".tabbrowser-tab") ?? []) {
      if (tab.selected || tab.multiselected) {
        for (const name of ["selected", "multiselected"]) {
          Object.defineProperty(tab, name, { get: () => false, configurable: true });
        }
        shadowed.push(tab);
      }
    }
    return () => {
      for (const tab of shadowed) {
        delete tab.selected;
        delete tab.multiselected;
      }
    };
  }

  const pinsAnimations = new Map();

  /** Секция закреплённых, если сворачивают их и они сейчас стоят сеткой. */
  function pinsGridSection(group) {
    const expanded = root.getAttribute("zen-sidebar-expanded") === "true";
    return isCollapsiblePins(group) && expanded && getPref(PREF_PINS_GRID)
      ? group.groupContainer
      : null;
  }

  /**
   * Сворачивание и раскрытие сетки закреплённых. Zen сдвигает содержимое
   * области вверх отступом служебного элемента, а в сетке такой сдвиг не
   * работает. Поэтому здесь высоту области ведёт своя анимация, а конечный
   * вид свёрнутой области задан в chrome.css.
   *
   * @param {Element} section - Секция закреплённых.
   * @param {number} from - Её высота до переключения, снятая без пересчёта раскладки.
   */
  function animatePins(section, from) {
    // Прошлая анимация могла не закончиться: её высота мешала бы измерить конечную.
    pinsAnimations.get(section)?.cancel();
    pinsAnimations.delete(section);
    section.removeAttribute("zbm-pins-anim");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    // Высота после переключения: атрибут Zen уже поменял, пересчёт даёт конечный вид.
    const to = section.getBoundingClientRect().height;
    if (Math.abs(from - to) < 1) {
      return;
    }
    section.setAttribute("zbm-pins-anim", "");
    const animation = section.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: PINS_ANIMATION_MS, easing: "ease-in-out" }
    );
    pinsAnimations.set(section, animation);
    animation.finished.then(
      () => {
        if (pinsAnimations.get(section) === animation) {
          pinsAnimations.delete(section);
          section.removeAttribute("zbm-pins-anim");
        }
      },
      () => {}
    );
  }

  function installFolderAnimations() {
    const folders = gZenFolders;
    const bounds = el => window.windowUtils.getBoundsWithoutFlushing(el).height;

    const originalCollapse = folders.animateCollapse;
    const collapse = function (group, ...rest) {
      let restore = null;
      let section = null;
      let from = 0;
      try {
        if (getPref(PREF_COLLAPSE_HIDES_ALL)) {
          restore = pretendNothingSelected(group);
        }
        section = pinsGridSection(group);
        from = section ? bounds(section) : 0;
      } catch (error) {
        console.error("[zen-browser-mod] folder collapse tweak failed:", error);
      }
      try {
        return originalCollapse.call(this, group, ...rest);
      } finally {
        try {
          restore?.();
          if (section) {
            animatePins(section, from);
          }
        } catch (error) {
          console.error("[zen-browser-mod] folder collapse tweak failed:", error);
        }
      }
    };

    const originalExpand = folders.animateExpand;
    const expand = function (group, ...rest) {
      let section = null;
      let from = 0;
      try {
        section = pinsGridSection(group);
        from = section ? bounds(section) : 0;
      } catch (error) {
        console.error("[zen-browser-mod] folder expand tweak failed:", error);
      }
      try {
        return originalExpand.call(this, group, ...rest);
      } finally {
        try {
          if (section) {
            animatePins(section, from);
          }
        } catch (error) {
          console.error("[zen-browser-mod] folder expand tweak failed:", error);
        }
      }
    };

    // Выбранную вкладку свёрнутой папки достаёт наружу обработчик Zen. При
    // смене пространства вкладка выбирается сама, без действия человека.
    const originalSelect = folders.on_TabSelect;
    const select = function (...args) {
      let skip = false;
      try {
        skip = getPref(PREF_COLLAPSE_HIDES_ALL) && changingSpace();
      } catch (error) {
        console.error("[zen-browser-mod] folder select tweak failed:", error);
      }
      return skip ? undefined : originalSelect.apply(this, args);
    };

    folders.animateCollapse = collapse;
    folders.animateExpand = expand;
    folders.on_TabSelect = select;
    cleanups.push(() => {
      if (Object.hasOwn(folders, "on_TabSelect") && folders.on_TabSelect === select) {
        delete folders.on_TabSelect;
      }
      if (Object.hasOwn(folders, "animateCollapse") && folders.animateCollapse === collapse) {
        delete folders.animateCollapse;
      }
      if (Object.hasOwn(folders, "animateExpand") && folders.animateExpand === expand) {
        delete folders.animateExpand;
      }
      for (const [section, animation] of pinsAnimations) {
        animation.cancel();
        section.removeAttribute("zbm-pins-anim");
      }
      pinsAnimations.clear();
    });
  }

  /*
   * Колонок в сетке закреплённых столько же, сколько в сетке важных.
   *
   * Число колонок у важных Zen подбирает сам по их количеству и ширине
   * панели, настройки для него нет: предел в три колонки задаёт chrome.css по
   * настройке мода. Здесь число считается по готовой раскладке и передаётся
   * в chrome.css переменной. Если важные стоят в одну-две
   * колонки или их нет, переменной нет, и сетка считает колонки по-своему.
   */
  let columnsFrame = 0;
  function syncEssentialColumns() {
    columnsFrame = 0;
    let columns = 0;
    try {
      const moving = gBrowser.tabContainer.hasAttribute("movingtab");
      if (moving) {
        // При перетаскивании важные сдвинуты, считать по ним нельзя.
        return;
      }
      if (getPref(PREF_PINS_GRID)) {
        const container = gZenWorkspaces.getCurrentEssentialsContainer?.();
        const tabs = [...(container?.children ?? [])].filter(el => gBrowser.isTab(el));
        const first = tabs[0]?.getBoundingClientRect();
        if (first?.height) {
          columns = tabs.filter(
            tab => Math.abs(tab.getBoundingClientRect().top - first.top) < 1
          ).length;
        }
      }
    } catch (error) {
      console.error("[zen-browser-mod] essentials column count failed:", error);
    }
    // Предел сменили, а важные ещё не перестроились: сетке хватит самого предела.
    columns = Math.min(columns, getPref(PREF_MAX_THREE) ? 3 : 4);
    if (columns >= 3) {
      root.style.setProperty("--zbm-essential-columns", columns);
    } else {
      root.style.removeProperty("--zbm-essential-columns");
    }
  }

  function queueEssentialColumns() {
    if (!columnsFrame && !disposed) {
      columnsFrame = requestAnimationFrame(syncEssentialColumns);
    }
  }

  function installEssentialColumns() {
    const essentials = document.getElementById("zen-essentials");
    if (essentials) {
      const mutations = new MutationObserver(queueEssentialColumns);
      mutations.observe(essentials, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden"],
      });
      const resizes = new ResizeObserver(queueEssentialColumns);
      resizes.observe(essentials);
      cleanups.push(() => {
        mutations.disconnect();
        resizes.disconnect();
      });
    }
    const observer = { observe: queueEssentialColumns };
    Services.prefs.addObserver(PREF_PINS_GRID, observer);
    Services.prefs.addObserver(PREF_MAX_THREE, observer);
    // Конец перетаскивания: важные вернулись на места.
    listen(window, "dragend", queueEssentialColumns, true);
    listen(window, "drop", queueEssentialColumns, true);
    cleanups.push(() => {
      Services.prefs.removeObserver(PREF_PINS_GRID, observer);
      Services.prefs.removeObserver(PREF_MAX_THREE, observer);
      cancelAnimationFrame(columnsFrame);
      root.style.removeProperty("--zbm-essential-columns");
    });
    queueEssentialColumns();
  }

  /*
   * Подсказка у крестика закреплённой вкладки.
   *
   * Крестиком мод рисует кнопку Zen «выгрузить вкладку», и подсказка у неё
   * остаётся про выгрузку. Пока Zen настроен закрывать вкладку этой кнопкой,
   * подсказка берётся та же, что у обычного крестика.
   */
  const CLOSE_TOOLTIP = "tabbrowser-close-tabs-button";
  const UNLOAD_TOOLTIP = "tabbrowser-unload-tab-button";

  function onTabButtonHover(event) {
    const button = event.target;
    if (
      !button?.classList?.contains("tab-reset-button") ||
      !button.parentElement?.classList.contains("tab-content")
    ) {
      return;
    }
    const closes =
      getPref(PREF_UNLOAD_HIDE) &&
      Services.prefs.getStringPref(PREF_ZEN_CLOSE_BEHAVIOR, "") === "close";
    const wanted = closes ? CLOSE_TOOLTIP : UNLOAD_TOOLTIP;
    if (button.getAttribute("data-l10n-id") !== wanted) {
      document.l10n.setAttributes(button, wanted, { tabCount: 1 });
    }
  }

  function restoreTabButtonTooltips() {
    const changed = document.querySelectorAll(
      `.tab-content > .tab-reset-button[data-l10n-id="${CLOSE_TOOLTIP}"]`
    );
    for (const button of changed) {
      document.l10n.setAttributes(button, UNLOAD_TOOLTIP, { tabCount: 1 });
    }
  }

  /*
   * Список вкладок не прокручивается к активной вкладке при смене пространства.
   *
   * К активной вкладке список подводит _handleTabSelect. Пропускаем его вызовы,
   * пока Zen меняет пространство. Кнопка «прокрутить к вкладке» зовёт тот же
   * метод в другое время и продолжает работать.
   */
  function installAutoscrollGuard() {
    const container = gBrowser.tabContainer;
    const original = container._handleTabSelect;
    const wrapper = function (...args) {
      let skip = false;
      try {
        skip = getPref(PREF_NO_AUTOSCROLL) && !!window.gZenWorkspaces?.isChangingWorkspace;
      } catch (error) {
        console.error("[zen-browser-mod] autoscroll guard failed:", error);
      }
      return skip ? undefined : original.apply(this, args);
    };
    container._handleTabSelect = wrapper;
    cleanups.push(() => {
      if (Object.hasOwn(container, "_handleTabSelect") && container._handleTabSelect === wrapper) {
        delete container._handleTabSelect;
      }
    });
  }

  /*
   * Жест перелистывания пространств.
   *
   * Удался ли свайп, решает система по двум числам, которые Zen кладёт в
   * каждое событие жеста: какую долю ширины надо протащить и сколько весит
   * скорость. Наш обработчик стоит после обработчика Zen и подменяет числа,
   * чтобы короткий быстрый жест тоже считался. Подменяем только обычное
   * перелистывание: у жеста «создать пространство» Zen ставит свой, высокий
   * порог, и его трогать нельзя, иначе пространства будут создаваться случайно.
   */
  function onSwipe(event) {
    if (!getPref(PREF_SWIPE) || !("swipeSuccessThreshold" in event)) {
      return;
    }
    const regular = window.gZenWorkspaces?._swipeManager?.constructor.SUCCESS_THRESHOLD ?? 0.25;
    if (Math.abs(event.swipeSuccessThreshold - regular) > 1e-6) {
      return;
    }
    event.swipeSuccessThreshold = Math.min(getNumber(PREF_SWIPE_THRESHOLD, 0.12), 0.9);
    event.swipeSuccessVelocityContribution = getNumber(PREF_SWIPE_VELOCITY, 1);
  }

  function install() {
    listen(window, "TabSelect", scheduleHide);
    installFolderAnimations();
    installEssentialColumns();
    listen(gNavToolbox, "mouseover", onTabButtonHover, true);
    cleanups.push(restoreTabButtonTooltips);
    installAutoscrollGuard();
    for (const type of ["MozSwipeGestureStart", "MozSwipeGestureUpdate"]) {
      listen(gNavToolbox, type, onSwipe, true);
    }
  }

  function uninstall() {
    disposed = true;
    clearTimeout(readyTimer);
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    clearTimeout(hideTimer);
  }

  // Ждём, пока Zen соберёт панель и повесит свой обработчик жеста: наш должен
  // встать после него, иначе последним числа запишет Zen.
  let attempts = 0;
  function whenReady() {
    if (disposed) {
      return;
    }
    let ready = false;
    try {
      ready = !!(
        window.gBrowser?.tabContainer &&
        window.gZenFolders &&
        window.gZenWorkspaces?.activeWorkspaceElement &&
        // Обработчика жеста может не быть вовсе, если жесты в Zen выключены.
        (window.gZenWorkspaces._swipeManager || attempts > 50)
      );
    } catch {}
    if (ready) {
      try {
        install();
      } catch (error) {
        console.error("[zen-browser-mod] behavior script failed to start:", error);
        uninstall();
      }
    } else if (attempts++ < 150) {
      readyTimer = setTimeout(whenReady, 200);
    }
  }
  whenReady();

  window.addUnloadListener?.(uninstall);
})();
