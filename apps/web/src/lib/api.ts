let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Не удалось связаться с сервером. Проверьте соединение и повторите запрос.",
    );
  }
  const fallback =
    response.status === 401
      ? "Сессия истекла. Войдите заново."
      : response.status === 403
        ? "Недостаточно прав для этого действия."
        : response.status === 429
          ? "Слишком много запросов. Подождите и повторите попытку."
          : "Не удалось выполнить запрос. Повторите попытку.";
  let data: T & { error?: string };
  try {
    data = (await response.json()) as T & { error?: string };
  } catch {
    throw new ApiError(
      response.status,
      response.ok
        ? "Сервер вернул некорректный ответ. Повторите запрос."
        : fallback,
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      data && typeof data.error === "string" ? data.error : fallback,
    );
  return data;
}
export async function copyToClipboard(value: string) {
  if (!navigator.clipboard?.writeText)
    throw new Error(
      "Копирование недоступно. Откройте Custodian по HTTPS или скопируйте значение вручную.",
    );
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    throw new Error(
      "Не удалось скопировать. Проверьте разрешения браузера для буфера обмена.",
    );
  }
}
export function download(name: string, data: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function recoveryDownload(
  code: string,
  vaultName: string,
  epoch: number,
) {
  download(
    `custodian-rescue-epoch-${epoch}.txt`,
    `${code}\n\nCustodian: ${vaultName}\nEpoch: ${epoch}\nСоздан: ${new Date().toISOString()}\nХраните отдельно от сервера. Не отправляйте этот файл в чат.\nCLI принимает первую строку файла как ключ.\n`,
  );
}
