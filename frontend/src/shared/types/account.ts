import type { MembershipRole, UserRole, UserStatus } from "./auth";

export type CurrentAccount = {
  id: number;
  name: string;
  slug: string;
  role: MembershipRole;
  token_balance: number;
  monthly_token_credit: number;
  profile_image_url: string | null;
};

export type TeamMember = {
  membership_id: number;
  user_id: number;
  email: string;
  full_name: string | null;
  role: MembershipRole;
  status: UserStatus;
  joined_at: string;
};

export type ManagedUser = {
  id: number;
  email: string;
  full_name: string | null;
  status: UserStatus;
  user_role: UserRole;
  permissions: string[];
  managed_by_user_id: number | null;
  account_id: number | null;
  account_name: string | null;
  account_slug: string | null;
  created_at: string;
};
