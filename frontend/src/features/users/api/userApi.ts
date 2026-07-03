import { apiClient } from "../../../lib/api/client";
import type { ManagedUser } from "../../../shared/types/account";
import type { UserStatus } from "../../../shared/types/auth";

export type CreateSuperAdminPayload = {
  email: string;
  password: string;
  full_name?: string;
  status: UserStatus;
  account_name: string;
  account_slug: string;
  permissions: string[];
};

export type UpdateSuperAdminPayload = {
  full_name?: string;
  password?: string;
  status?: UserStatus;
  permissions?: string[];
};

export type CreateAdminPayload = {
  email: string;
  password: string;
  full_name?: string;
  status: UserStatus;
  permissions: string[];
};

export type UpdateAdminPayload = {
  full_name?: string;
  password?: string;
  status?: UserStatus;
  permissions?: string[];
};

export async function listManagedUsers(): Promise<ManagedUser[]> {
  const response = await apiClient.get<ManagedUser[]>("/users");
  return response.data;
}

export async function createSuperAdmin(payload: CreateSuperAdminPayload): Promise<ManagedUser> {
  const response = await apiClient.post<ManagedUser>("/users/super-admins", payload);
  return response.data;
}

export async function updateSuperAdmin(userId: number, payload: UpdateSuperAdminPayload): Promise<ManagedUser> {
  const response = await apiClient.patch<ManagedUser>(`/users/super-admins/${userId}`, payload);
  return response.data;
}

export async function createAdmin(payload: CreateAdminPayload): Promise<ManagedUser> {
  const response = await apiClient.post<ManagedUser>("/users/admins", payload);
  return response.data;
}

export async function updateAdmin(userId: number, payload: UpdateAdminPayload): Promise<ManagedUser> {
  const response = await apiClient.patch<ManagedUser>(`/users/admins/${userId}`, payload);
  return response.data;
}

export async function deleteAdmin(userId: number): Promise<void> {
  await apiClient.delete(`/users/admins/${userId}`);
}

export async function resetUserPassword(userId: number): Promise<void> {
  await apiClient.post(`/users/${userId}/reset-password`);
}
