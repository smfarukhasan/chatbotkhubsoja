import { FormEvent, useEffect, useState } from "react";

import { CustomField } from "../components/common/CustomField";
import { LoadingPanel } from "../components/common/LoadingPanel";
import { CustomMultiSelect, CustomSelect } from "../components/common/CustomSelect";
import { useAuthStore } from "../features/auth/store/authStore";
import {
  createAdmin,
  createSuperAdmin,
  deleteAdmin,
  listManagedUsers,
  updateAdmin,
  updateSuperAdmin,
  resetUserPassword,
} from "../features/users/api/userApi";
import type { ManagedUser } from "../shared/types/account";
import type { UserStatus } from "../shared/types/auth";

const ADMIN_PERMISSION_OPTIONS = [
  "team:read",
  "team:manage",
  "key:manage",
  "connection:read",
  "connection:manage",
  "inbox:read",
  "inbox:manage",
  "comments:read",
  "comments:manage",
  "posts:read",
  "posts:manage",
  "ai:read",
  "ai:manage",
  "automation:read",
  "automation:manage",
  "reports:read",
];

const USER_STATUS_OPTIONS: Array<{ value: UserStatus; label: string }> = [
  { value: "active", label: "active" },
  { value: "invited", label: "invited" },
  { value: "disabled", label: "disabled" },
];

const ADMIN_PERMISSION_SELECT_OPTIONS = ADMIN_PERMISSION_OPTIONS.map((permission) => ({
  value: permission,
  label: permission,
}));

const SUPER_ADMIN_FEATURE_OPTIONS = [
  { value: "feature:whatsapp_inbox", label: "WhatsApp inbox" },
  { value: "feature:facebook_inbox", label: "Facebook inbox" },
  { value: "feature:facebook_comments", label: "Facebook comments" },
  { value: "feature:facebook_posts", label: "Facebook posts" },
];

const SUPER_ADMIN_FEATURE_LABELS = Object.fromEntries(
  SUPER_ADMIN_FEATURE_OPTIONS.map((option) => [option.value, option.label]),
) as Record<string, string>;

function buildAccountSlug(businessName: string): string {
  const normalized = businessName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const seed = Date.now().toString(36);
  const base = (normalized || "business").slice(0, 84);
  return `${base}-${seed}`.replace(/-+$/g, "");
}

export function TeamPage() {
  const activeAccountId = useAuthStore((state) => state.activeAccountId);
  const user = useAuthStore((state) => state.user);
  const [members, setMembers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editingSuperAdminId, setEditingSuperAdminId] = useState<number | null>(null);
  const [editingAdminId, setEditingAdminId] = useState<number | null>(null);
  const [superAdminForm, setSuperAdminForm] = useState({
    owner_name: "",
    email: "",
    password: "",
    confirm_password: "",
    status: "active" as UserStatus,
    business_name: "",
    permissions: [] as string[],
  });
  const [adminForm, setAdminForm] = useState({
    full_name: "",
    email: "",
    password: "",
    status: "active" as UserStatus,
    permissions: ["team:read", "reports:read"],
  });

  const canManageSuperAdmins = user?.user_role === "owner";
  const canManageAdmins = user?.user_role === "superAdmin";

  const resetSuperAdminForm = () => {
    setEditingSuperAdminId(null);
    setSuperAdminForm({
      owner_name: "",
      email: "",
      password: "",
      confirm_password: "",
      status: "active",
      business_name: "",
      permissions: [],
    });
  };

  const resetAdminForm = () => {
    setEditingAdminId(null);
    setAdminForm({
      full_name: "",
      email: "",
      password: "",
      status: "active",
      permissions: ["team:read", "reports:read"],
    });
  };

  const loadMembers = () => {
    setLoading(true);
    listManagedUsers()
      .then((response) => {
        setMembers(response);
        setError(null);
      })
      .catch((err: any) => {
        setError(err.response?.data?.detail ?? "Unable to load managed users.");
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const handleResetPassword = async (memberId: number, email: string) => {
    const ok = window.confirm(`Are you sure you want to reset password for ${email} to "87654321"?`);
    if (!ok) return;

    try {
      setLoading(true);
      await resetUserPassword(memberId);
      setMessage(`Password for ${email} has been successfully reset to "87654321".`);
      setTimeout(() => setMessage(null), 5000);
      await loadMembers();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || "Failed to reset password.");
      setTimeout(() => setError(null), 5000);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMembers();
  }, [activeAccountId]);

  const handleCreateSuperAdmin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const isEditing = editingSuperAdminId !== null;
      if (!isEditing && superAdminForm.password !== superAdminForm.confirm_password) {
        setError("Password and Re-Password do not match.");
        return;
      }
      if (
        isEditing &&
        superAdminForm.password &&
        superAdminForm.confirm_password &&
        superAdminForm.password !== superAdminForm.confirm_password
      ) {
        setError("Password and Re-Password do not match.");
        return;
      }
      if (superAdminForm.permissions.length === 0) {
        setError("Select at least one feature for the super admin.");
        return;
      }

      if (isEditing) {
        await updateSuperAdmin(editingSuperAdminId, {
          full_name: superAdminForm.owner_name || undefined,
          status: superAdminForm.status,
          permissions: superAdminForm.permissions,
          password: superAdminForm.password || undefined,
        });
        setMessage("Super admin updated successfully.");
      } else {
        await createSuperAdmin({
          email: superAdminForm.email,
          password: superAdminForm.password,
          full_name: superAdminForm.owner_name || undefined,
          status: superAdminForm.status,
          account_name: superAdminForm.business_name,
          account_slug: buildAccountSlug(superAdminForm.business_name),
          permissions: superAdminForm.permissions,
        });
        setMessage("Super admin created successfully.");
      }
      resetSuperAdminForm();
      loadMembers();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to save super admin.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateAdmin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      if (editingAdminId !== null) {
        await updateAdmin(editingAdminId, {
          full_name: adminForm.full_name || undefined,
          status: adminForm.status,
          permissions: adminForm.permissions,
          password: adminForm.password || undefined,
        });
        setMessage("Admin updated successfully.");
      } else {
        await createAdmin(adminForm);
        setMessage("Admin created successfully.");
      }
      resetAdminForm();
      loadMembers();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to save admin.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteAdmin = async (userId: number) => {
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      await deleteAdmin(userId);
      setMessage("Admin disabled successfully.");
      loadMembers();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to delete admin.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditMember = (member: ManagedUser) => {
    setError(null);
    setMessage(null);

    if (member.user_role === "superAdmin" && canManageSuperAdmins) {
      setEditingSuperAdminId(member.id);
      setSuperAdminForm({
        owner_name: member.full_name ?? "",
        email: member.email,
        password: "",
        confirm_password: "",
        status: member.status,
        business_name: member.account_name ?? "",
        permissions: member.permissions.filter((permission) => permission.startsWith("feature:")),
      });
      return;
    }

    if (member.user_role === "admin" && canManageAdmins) {
      setEditingAdminId(member.id);
      setAdminForm({
        full_name: member.full_name ?? "",
        email: member.email,
        password: "",
        status: member.status,
        permissions: member.permissions,
      });
    }
  };

  return (
    <section>
      {message ? <div className="panel success-panel">{message}</div> : null}
      {error ? <div className="panel error-panel">{error}</div> : null}
      {loading ? <LoadingPanel message="Loading managed users..." hint="Refreshing workspace members and permissions." /> : null}

      {canManageSuperAdmins ? (
        <form className="panel form-panel two-column-form super-admin-form-panel" onSubmit={handleCreateSuperAdmin}>
          <h3 className="super-admin-form-title">{editingSuperAdminId ? "Update super admin" : "Create super admin"}</h3>
          <label>
            Business name:
            <CustomField
              placeholder="e.g. Khub Soja"
              value={superAdminForm.business_name}
              onChange={(event) => setSuperAdminForm((current) => ({ ...current, business_name: event.target.value }))}
              disabled={editingSuperAdminId !== null}
              required
            />
          </label>
          <label>
            Owner name:
            <CustomField
              placeholder="e.g. S. M. Faruk Hasan"
              value={superAdminForm.owner_name}
              onChange={(event) => setSuperAdminForm((current) => ({ ...current, owner_name: event.target.value }))}
            />
          </label>
          <label>
            Email:
            <CustomField
              type="email"
              placeholder="khubsoja@example.com"
              value={superAdminForm.email}
              onChange={(event) => setSuperAdminForm((current) => ({ ...current, email: event.target.value }))}
              disabled={editingSuperAdminId !== null}
              required
            />
          </label>
          <label>
            Status:
            <CustomSelect
              value={superAdminForm.status}
              onChange={(value) => setSuperAdminForm((current) => ({ ...current, status: value as UserStatus }))}
              options={USER_STATUS_OPTIONS}
              placeholder="Select user status"
            />
          </label>
          <label>
            Password:
            <CustomField
              type="password"
              placeholder={editingSuperAdminId ? "Leave blank to keep existing password" : "Minimum 8 characters"}
              value={superAdminForm.password}
              onChange={(event) => setSuperAdminForm((current) => ({ ...current, password: event.target.value }))}
              minLength={8}
              required={editingSuperAdminId === null}
            />
          </label>
          {editingSuperAdminId === null ? (
            <label>
              Re-Password:
              <CustomField
                type="password"
                placeholder="Re-enter password"
                value={superAdminForm.confirm_password}
                onChange={(event) => setSuperAdminForm((current) => ({ ...current, confirm_password: event.target.value }))}
                minLength={8}
                required
              />
            </label>
          ) : null}
          <div className="feature-access-row">
            <p className="feature-access-label">Feature access:</p>
            <div className="feature-access-grid">
              {SUPER_ADMIN_FEATURE_OPTIONS.map((option) => {
                const checked = superAdminForm.permissions.includes(option.value);
                return (
                  <label
                    key={option.value}
                    className={`feature-access-item ${checked ? "selected" : ""}`.trim()}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSuperAdminForm((current) => ({
                          ...current,
                          permissions: checked
                            ? current.permissions.filter((item) => item !== option.value)
                            : [...current.permissions, option.value],
                        }))
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="form-action-row">
            <button type="submit" className="form-primary-button super-admin-submit-button" disabled={submitting}>{submitting ? "Saving..." : editingSuperAdminId ? "Update super admin" : "Create super admin"}</button>
            {editingSuperAdminId ? (
              <button type="button" className="secondary-action form-cancel-button" onClick={resetSuperAdminForm} disabled={submitting}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      {canManageAdmins ? (
        <form className="panel form-panel two-column-form" onSubmit={handleCreateAdmin}>
          <h3>{editingAdminId ? "Update admin" : "Create admin"}</h3>
          <label>
            Full name:
            <CustomField
              placeholder="e.g. Support Manager"
              value={adminForm.full_name}
              onChange={(event) => setAdminForm((current) => ({ ...current, full_name: event.target.value }))}
            />
          </label>
          <label>
            Email:
            <CustomField
              type="email"
              placeholder="admin@business.com"
              value={adminForm.email}
              onChange={(event) => setAdminForm((current) => ({ ...current, email: event.target.value }))}
              required
            />
          </label>
          <label>
            Status:
            <CustomSelect
              value={adminForm.status}
              onChange={(value) => setAdminForm((current) => ({ ...current, status: value as UserStatus }))}
              options={USER_STATUS_OPTIONS}
              placeholder="Select user status"
            />
          </label>
          <label>
            Password:
            <CustomField
              type="password"
              placeholder={editingAdminId ? "Leave blank to keep existing password" : "Minimum 8 characters"}
              value={adminForm.password}
              onChange={(event) => setAdminForm((current) => ({ ...current, password: event.target.value }))}
              minLength={8}
              required={editingAdminId === null}
            />
          </label>
          <label>
            Permissions:
            <CustomMultiSelect
              value={adminForm.permissions}
              onChange={(value) => setAdminForm((current) => ({ ...current, permissions: value }))}
              options={ADMIN_PERMISSION_SELECT_OPTIONS}
              placeholder="Choose permissions"
            />
          </label>
          <div className="form-action-row">
            <button type="submit" className="form-primary-button" disabled={submitting}>{submitting ? "Saving..." : editingAdminId ? "Update admin" : "Create admin"}</button>
            {editingAdminId ? (
              <button type="button" className="secondary-action form-cancel-button" onClick={resetAdminForm} disabled={submitting}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      {!loading && !error ? (
        <div className="user-grid">
          {members.map((member) => (
            <article key={member.id} className="panel user-card">
              <div className="user-card-head">
                <h4>{member.full_name || "Unspecified"}</h4>
                 <div className="user-card-head-actions">
                  <span className={`status-pill status-${member.status}`}>{member.status}</span>
                  {(member.user_role === "superAdmin" && canManageSuperAdmins) || (member.user_role === "admin" && canManageAdmins) ? (
                    <button
                      type="button"
                      className="link-button icon-link-button"
                      aria-label="Edit user"
                      title="Edit"
                      onClick={() => handleEditMember(member)}
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24" className="edit-pen-icon">
                        <path d="M3 17.25V21h3.75L18.81 8.94l-3.75-3.75z" />
                        <path d="M14.06 5.19l3.75 3.75" />
                      </svg>
                    </button>
                  ) : null}
                </div>
              </div>

              <dl className="user-card-meta">
                <div>
                  <dt>Email:</dt>
                  <dd>{member.email}</dd>
                </div>
                <div>
                  <dt>User role:</dt>
                  <dd>{member.user_role}</dd>
                </div>
                <div>
                  <dt>Workspace:</dt>
                  <dd>{member.account_name || "-"}</dd>
                </div>
                <div>
                  <dt>Role:</dt>
                  <dd>{member.user_role === "superAdmin" ? "owner" : "admin"}</dd>
                </div>
                <div>
                  <dt>Status:</dt>
                  <dd>{member.status}</dd>
                </div>
                <div>
                  <dt>Password:</dt>
                  <dd>
                    {(member.user_role === "superAdmin" && canManageSuperAdmins) || (member.user_role === "admin" && canManageAdmins) ? (
                      <button
                        type="button"
                        className="link-button warning-link"
                        onClick={() => handleResetPassword(member.id, member.email)}
                        style={{ fontSize: "14px", color: "#e67e22", cursor: "pointer", background: "none", border: "none", padding: 0, textDecoration: "underline", fontWeight: "normal" }}
                      >
                        Reset
                      </button>
                    ) : (
                      "-"
                    )}
                  </dd>
                </div>
              </dl>

              <div className="user-card-controls">
                <label>
                  Permissions:
                  <p className="user-card-permissions">
                    {member.permissions.map((permission) => SUPER_ADMIN_FEATURE_LABELS[permission] ?? permission).join(", ") || "-"}
                  </p>
                </label>
              </div>

              <div className="user-card-actions">
                {member.user_role === "admin" && canManageAdmins ? (
                  <button type="button" className="link-button danger-link" onClick={() => handleDeleteAdmin(member.id)}>
                    Delete
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
