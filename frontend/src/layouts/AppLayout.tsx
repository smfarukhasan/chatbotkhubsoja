import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { AvatarCropDialog } from "../components/common/AvatarCropDialog";
import { CustomSelect } from "../components/common/CustomSelect";
import { useAuthStore } from "../features/auth/store/authStore";
import { logout } from "../features/auth/api/authApi";
import { getCurrentAccount, updateCurrentAccountProfile } from "../features/accounts/api/accountApi";
import { useFacebookPageScope } from "../features/platformConnections/hooks/useFacebookPageScope";
import { getBillingSummary } from "../features/reports/api/reportApi";
import { useResponsiveTables } from "../hooks/useResponsiveTables";
import type { CurrentAccount } from "../shared/types/account";

type NavItem = {
  to: string;
  label: string;
  featurePermission?: string;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const NAV_SECTIONS = [
  {
    title: "Overview",
    items: [{ to: "/", label: "Dashboard" }],
  },
  {
    title: "Operations",
    items: [
      { to: "/inbox/whatsapp", label: "WhatsApp Inbox", featurePermission: "feature:whatsapp_inbox" },
      { to: "/inbox/facebook", label: "Facebook Inbox", featurePermission: "feature:facebook_inbox" },
      { to: "/comments", label: "Facebook Comments", featurePermission: "feature:facebook_comments" },
      { to: "/posts", label: "Facebook Posts", featurePermission: "feature:facebook_posts" },
      { to: "/products", label: "Products" },
      { to: "/automation", label: "Automation" },
      { to: "/connections", label: "Channels" },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { to: "/ai", label: "AI Overview" },
      { to: "/ai/agents", label: "AI Agents" },
      { to: "/ai/prompts", label: "Prompts" },
      { to: "/ai/knowledge", label: "Knowledge" },
      { to: "/ai/style", label: "Style" },
      { to: "/ai/faq", label: "FAQs" },
    ],
  },
  {
    title: "Revenue",
    items: [
      { to: "/billing", label: "Billing" },
      { to: "/wallet", label: "Wallet" },
      { to: "/usage", label: "Usage" },
      { to: "/audit-logs", label: "Audit Logs" },
    ],
  },
  {
    title: "Account",
    items: [
      { to: "/setup", label: "Setup" },
      { to: "/team", label: "Users" },
      { to: "/security/password", label: "Change Password" },
    ],
  },
] satisfies NavSection[];

export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const activeAccountId = useAuthStore((state) => state.activeAccountId);
  const clear = useAuthStore((state) => state.clear);
  const refreshToken = useAuthStore((state) => state.refreshToken);
  const {
    connections: facebookConnections,
    loadingConnections: loadingFacebookConnections,
    activeFacebookConnectionId,
    activeConnection: activeFacebookConnection,
    hasMultipleConnections: hasMultipleFacebookConnections,
    setActiveFacebookConnectionId,
  } = useFacebookPageScope();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [usedTokenPercent, setUsedTokenPercent] = useState<number | null>(null);
  const [currentAccount, setCurrentAccount] = useState<CurrentAccount | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [savingProfileImage, setSavingProfileImage] = useState(false);
  const profileHoldTimerRef = useRef<number | null>(null);
  const profileLongPressTriggeredRef = useRef(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useResponsiveTables(location.pathname);

  const visibleSections = useMemo(() => {
    if (!user) {
      return NAV_SECTIONS;
    }

    const isOwnerOrSuper = user.user_role === "owner" || user.user_role === "superAdmin";

    return NAV_SECTIONS.map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (item.to === "/team" && !isOwnerOrSuper) {
          return false;
        }
        if (user.user_role === "owner") {
          return true;
        }
        if (!item.featurePermission) {
          return true;
        }
        const selectedFeatures = new Set(
          (user.permissions ?? []).filter((permission) => permission.startsWith("feature:")),
        );
        const hasFeatureSelection = selectedFeatures.size > 0;
        if (!hasFeatureSelection) {
          return true;
        }
        return selectedFeatures.has(item.featurePermission);
      }),
    })).filter((section) => section.items.length > 0);
  }, [user]);

  const currentPage = useMemo(() => {
    const allItems = visibleSections.flatMap((section) => section.items);
    const matchedItems = allItems.filter((item) => {
      if (item.to === "/") {
        return location.pathname === "/";
      }
      return location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
    });

    return matchedItems.sort((left, right) => right.to.length - left.to.length)[0];
  }, [location.pathname, visibleSections]);

  const currentPageTitle = useMemo(() => {
    if (currentPage && currentPage.to.startsWith("/ai/") && currentPage.to !== "/ai") {
      return `AI Overview (${currentPage.label})`;
    }
    return currentPage?.label ?? "Workspace";
  }, [currentPage]);

  const activeMembership = useMemo(
    () =>
      user?.memberships.find(
        (membership) => membership.account_id === activeAccountId && membership.status === "active",
      ) ?? user?.memberships.find((membership) => membership.status === "active") ?? null,
    [activeAccountId, user?.memberships],
  );

  const businessName = currentAccount?.name || activeMembership?.account_name || "Workspace";

  const avatarFallback = useMemo(() => {
    const parts = businessName
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 2);
    if (parts.length === 0) return "SC";
    return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
  }, [businessName]);

  const showsFacebookPageSelector = useMemo(
    () =>
      ["/comments", "/posts", "/inbox/facebook"].some(
        (prefix) => location.pathname === prefix || location.pathname.startsWith(`${prefix}/`),
      ),
    [location.pathname],
  );

  const facebookPageOptions = useMemo(
    () =>
      facebookConnections.map((connection) => ({
        value: String(connection.id),
        label: connection.name,
        helper: connection.external_name || connection.external_id || undefined,
      })),
    [facebookConnections],
  );

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;

    async function loadCurrentAccount() {
      if (!activeAccountId) {
        setCurrentAccount(null);
        return;
      }

      try {
        const account = await getCurrentAccount();
        if (!cancelled) {
          setCurrentAccount(account);
        }
      } catch {
        if (!cancelled) {
          setCurrentAccount(null);
        }
      }
    }

    void loadCurrentAccount();
    return () => {
      cancelled = true;
    };
  }, [activeAccountId]);

  useEffect(() => {
    let cancelled = false;

    async function loadTokenUsagePercent() {
      if (!activeAccountId) {
        setUsedTokenPercent(null);
        return;
      }

      try {
        const summary = await getBillingSummary();
        const monthlyCredit = Math.max(summary.monthly_token_credit ?? 0, 0);
        if (monthlyCredit === 0) {
          if (!cancelled) setUsedTokenPercent(0);
          return;
        }

        const raw = (summary.billed_tokens / monthlyCredit) * 100;
        const percent = Math.max(0, Math.min(100, Math.round(raw)));
        if (!cancelled) setUsedTokenPercent(percent);
      } catch {
        if (!cancelled) setUsedTokenPercent(null);
      }
    }

    loadTokenUsagePercent();
    return () => {
      cancelled = true;
    };
  }, [activeAccountId]);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [profileMenuOpen]);

  useEffect(
    () => () => {
      if (profileHoldTimerRef.current) {
        window.clearTimeout(profileHoldTimerRef.current);
      }
    },
    [],
  );

  const handleLogout = async () => {
    try {
      if (refreshToken) {
        await logout(refreshToken);
      }
    } finally {
      clear();
      navigate("/login");
    }
  };

  const clearProfileHoldTimer = () => {
    if (profileHoldTimerRef.current) {
      window.clearTimeout(profileHoldTimerRef.current);
      profileHoldTimerRef.current = null;
    }
  };

  const startProfileHold = () => {
    clearProfileHoldTimer();
    profileLongPressTriggeredRef.current = false;
    profileHoldTimerRef.current = window.setTimeout(() => {
      profileLongPressTriggeredRef.current = true;
      setProfileMenuOpen(true);
    }, 450);
  };

  const handleProfileImageFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      setCropImageSrc(result);
      setProfileMenuOpen(false);
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const handleSaveProfileImage = async (dataUrl: string) => {
    setSavingProfileImage(true);
    try {
      const updatedAccount = await updateCurrentAccountProfile({ profile_image_url: dataUrl });
      setCurrentAccount(updatedAccount);
      setCropImageSrc(null);
    } finally {
      setSavingProfileImage(false);
    }
  };

  const handleDeleteProfileImage = async () => {
    setSavingProfileImage(true);
    try {
      const updatedAccount = await updateCurrentAccountProfile({ profile_image_url: null });
      setCurrentAccount(updatedAccount);
      setProfileMenuOpen(false);
    } finally {
      setSavingProfileImage(false);
    }
  };

  return (
    <div className={`shell ${sidebarOpen ? "nav-open" : ""}`}>
      <button
        aria-hidden={!sidebarOpen}
        aria-label="Close navigation"
        className="sidebar-backdrop"
        tabIndex={sidebarOpen ? 0 : -1}
        type="button"
        onClick={() => setSidebarOpen(false)}
      />

      <aside className="sidebar">
        <div className="sidebar-inner">
          <div className="sidebar-header">
            <div className="sidebar-brand">
              <div className="sidebar-profile-shell" ref={profileMenuRef}>
                <button
                  type="button"
                  className="brand-mark sidebar-profile-trigger"
                  aria-label="Business profile image"
                  onClick={() => {
                    if (profileLongPressTriggeredRef.current) {
                      profileLongPressTriggeredRef.current = false;
                    }
                  }}
                  onPointerDown={startProfileHold}
                  onPointerUp={clearProfileHoldTimer}
                  onPointerLeave={clearProfileHoldTimer}
                  onPointerCancel={clearProfileHoldTimer}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    clearProfileHoldTimer();
                    profileLongPressTriggeredRef.current = true;
                    setProfileMenuOpen(true);
                  }}
                >
                  {currentAccount?.profile_image_url ? (
                    <img src={currentAccount.profile_image_url} alt={businessName} className="sidebar-profile-image" />
                  ) : (
                    avatarFallback
                  )}
                </button>
                {profileMenuOpen ? (
                  <div className="sidebar-profile-menu">
                    <button
                      type="button"
                      className="ghost-button compact-button"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Edit image
                    </button>
                    <button
                      type="button"
                      className="ghost-button compact-button"
                      onClick={() => void handleDeleteProfileImage()}
                      disabled={savingProfileImage || !currentAccount?.profile_image_url}
                    >
                      Delete image
                    </button>
                  </div>
                ) : null}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="visually-hidden"
                  onChange={handleProfileImageFile}
                />
              </div>
              <div>
                <h1>{businessName}</h1>
              </div>
            </div>
            <button
              aria-label="Close navigation"
              className="sidebar-close"
              type="button"
              onClick={() => setSidebarOpen(false)}
            >
              Close
            </button>
          </div>

          <nav className="nav" aria-label="Primary navigation">
            {visibleSections.map((section) => (
              <div className="nav-section" key={section.title}>
                <p className="nav-section-title">{section.title}</p>
                <div className="nav-links">
                  {section.items.map((item) => (
                    <NavLink key={item.to} to={item.to}>
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </nav>

        </div>
      </aside>

      <div className="app-stage">
        <header className="topbar">
          <div className="topbar-main">
            <button
              aria-expanded={sidebarOpen}
              aria-label="Toggle navigation"
              className="menu-button"
              type="button"
              onClick={() => setSidebarOpen((current) => !current)}
            >
              <span className="menu-button-lines" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>Menu</span>
            </button>
            <div className="topbar-copy">
              <h2>{currentPageTitle}</h2>
            </div>
          </div>

          <div className="topbar-chip topbar-chip-inline topbar-usage-chip">
            <strong>{`Token used: ${usedTokenPercent ?? "--"}%`}</strong>
          </div>

          <div className="topbar-right">
            <div className="topbar-meta">
              {showsFacebookPageSelector && !loadingFacebookConnections && hasMultipleFacebookConnections ? (
                <div className="topbar-inline-select">
                  <CustomSelect
                    value={String(activeFacebookConnectionId ?? "")}
                    onChange={(value) => setActiveFacebookConnectionId(value ? Number(value) : null)}
                    options={facebookPageOptions}
                    placeholder="Select Facebook Page"
                    variant="compact"
                  />
                </div>
              ) : null}
              {showsFacebookPageSelector && !loadingFacebookConnections && !hasMultipleFacebookConnections && activeFacebookConnection ? (
                <div className="topbar-chip topbar-chip-inline">
                  <strong>{activeFacebookConnection.name}</strong>
                </div>
              ) : null}
            </div>
            <button className="ghost-button topbar-signout" type="button" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>

      <AvatarCropDialog
        open={Boolean(cropImageSrc)}
        imageSrc={cropImageSrc}
        saving={savingProfileImage}
        onCancel={() => setCropImageSrc(null)}
        onSave={(dataUrl) => void handleSaveProfileImage(dataUrl)}
      />
    </div>
  );
}
