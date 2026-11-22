/*
 * Правки поведения боковой панели, не связанные с перетаскиванием:
 * свёрнутые папки, автопрокрутка списка и жест перелистывания пространств.
 * Каждая включается своей настройкой и проверяет её в момент срабатывания.
 *
 * Сверено с исходниками Zen 1.24.3b: ZenFolders.mjs, ZenSpacesSwipe.mjs,
 * ZenSpaceManager.mjs.
 */
(() => {
  "use strict";

  const PREF_COLLAPSE_HIDES_ALL = "mod.zbm.folders.collapse-hides-all";
  const PREF_NO_AUTOSCROLL = "mod.zbm.sidebar.no-autoscroll-on-space-switch";
  const PREF_SWIPE = "mod.zbm.swipe.easier";
  const PREF_SWIPE_THRESHOLD = "mod.zbm.swipe.threshold";
  const PREF_SWIPE_VELOCITY = "mod.zbm.swipe.velocity";

  // Zen анимирует папку около 180 мс. Свою правку начинаем после него,
  // чтобы две анимации одной папки не шли одновременно.
  const FOLDER_SETTLE_MS = 350;

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
   * убирает её только при выгрузке. Здесь она уходит внутрь, как только с неё
   * ушёл фокус, а при сворачивании папки уходит и активная. То же для
   * закреплённых вкладок пространства, свёрнутых кликом по его названию.
   * Прячет вкладку штатная анимация Zen, сама вкладка при этом не выгружается.
   */
  const folderOf = tab =>
    tab.group?.hasAttribute("split-view-group") ? tab.group.group : tab.group;

  /** Лежит ли вкладка в этой папке. У свёрнутых закреплённых вкладки лежат не в самом элементе, а в его groupContainer. */
  const holds = (folder, tab) =>
    folder.contains(tab) || !!folder.groupContainer?.contains(tab);

  async function hideIntoFolders(collapsedNow = null) {
    const tabs = [...document.querySelectorAll(".tabbrowser-tab[folder-active]")];
    for (const tab of tabs) {
      // Пока шла предыдущая анимация, всё могло поменяться: проверяем заново.
      if (disposed || !getPref(PREF_COLLAPSE_HIDES_ALL)) {
        return;
      }
      if (!tab.isConnected || !tab.hasAttribute("folder-active") || tab.multiselected) {
        continue;
      }
      const owner = folderOf(tab);
      if (!owner?.isZenFolder || !owner.collapsed) {
        continue;
      }
      // Активная вкладка уходит только из той папки, которую сейчас свернули.
      if (tab.selected && !(collapsedNow?.collapsed && holds(collapsedNow, tab))) {
        continue;
      }
      await gZenFolders.animateUnload(owner, tab);
    }
  }

  const hideTimers = new Map();
  function scheduleHide(key, collapsedNow) {
    clearTimeout(hideTimers.get(key));
    hideTimers.set(
      key,
      setTimeout(() => {
        hideTimers.delete(key);
        hideIntoFolders(collapsedNow).catch(error =>
          console.error("[zen-browser-mod] hiding folder tab failed:", error)
        );
      }, FOLDER_SETTLE_MS)
    );
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
    listen(window, "TabSelect", () => scheduleHide("select"));
    listen(window, "TabGroupCollapse", event => scheduleHide("collapse", event.target));
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
    for (const timer of hideTimers.values()) {
      clearTimeout(timer);
    }
    hideTimers.clear();
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
