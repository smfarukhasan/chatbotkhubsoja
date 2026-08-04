import { apiClient } from "../../../lib/api/client";

export type Product = {
  id: number;
  name: string;
  description: string | null;
  price: string | null;
  currency: string | null;
  price_text: string | null;
  images: string[];
  category: string | null;
  is_available: boolean;
  platform_connection_id: number | null;
  created_at: string;
  updated_at: string;
};

export type ProductPayload = {
  name: string;
  platform_connection_id: number;
  images: string[];
  price?: number | null;
  currency?: string | null;
  price_text?: string | null;
  description?: string | null;
  category?: string | null;
};

export type ProductListParams = {
  connection_id?: number;
  q?: string;
  available?: boolean;
};

export async function listProducts(params: ProductListParams = {}): Promise<Product[]> {
  const response = await apiClient.get<Product[]>("/products", { params });
  return response.data;
}

export async function uploadProductImage(file: File): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append("image", file);
  const response = await apiClient.post<{ url: string }>("/products/upload-image", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return response.data;
}

export async function createProduct(payload: ProductPayload): Promise<Product> {
  const response = await apiClient.post<Product>("/products", payload);
  return response.data;
}

export async function updateProduct(productId: number, payload: Partial<ProductPayload>): Promise<Product> {
  const response = await apiClient.put<Product>(`/products/${productId}`, payload);
  return response.data;
}

export async function deleteProduct(productId: number): Promise<void> {
  await apiClient.delete(`/products/${productId}`);
}

export async function setProductAvailability(productId: number, is_available: boolean): Promise<Product> {
  const response = await apiClient.patch<Product>(`/products/${productId}/availability`, { is_available });
  return response.data;
}
