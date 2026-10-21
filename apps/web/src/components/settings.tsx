import { PageHeader } from "./page-header";
import { Card } from "./ui/card";
import { CardHeadRow } from "./card-head-row";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./ui/table";
import { useEffect, useRef, useState } from "react";
import { Download, ShieldCheck, Terminal } from "lucide-react";
import { toast } from "sonner";
import { type Backup } from "../../../../packages/core/src/index.ts";
import { api, download } from "../lib/api";
import type { VaultStore } from "../lib/store";
import { Enrollment } from "./auth";
import { Button } from "./ui/button";
import { TableLoading } from "./table-loading";
export function Settings({ store }: { store: VaultStore }) {
  const [busy, setBusy] = useState(false);
  const downloading = useRef(false);
  async function backup() {
    if (downloading.current) return;
    downloading.current = true;
    setBusy(true);
    try {
      const data = await api<Backup>("/backup");
      download(
        `custodian-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(data, null, 2),
        "application/json",
      );
      toast.success("Зашифрованная копия скачана.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      downloading.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="page-body settings-page">
      <PageHeader title="Настройки" />
      <div className="settings-columns">
        <section className="settings-section">
          <Enrollment store={store} />
          <div className="security-note">
            <ShieldCheck size={18} />
            <div>
              <strong>Один пароль или Passkey</strong>
              <p>
                Пароль открывает аккаунт и записи. Passkey с поддержкой PRF
                позволяет входить без пароля. Последний рабочий способ отключить
                нельзя.
              </p>
            </div>
          </div>
        </section>
        {store.session!.user.role === "owner" && (
          <section className="settings-section recovery-section">
            <h2>
              <Terminal size={19} />
              Резервная копия и rescue CLI
            </h2>
            <p>
              Копия содержит зашифрованные записи, включая корзину. Сохраните её
              вместе с rescue-ключом той же версии, отдельно от сервера.
            </p>
            <Button
              variant="outline"
              disabled={busy}
              aria-busy={busy}
              onClick={backup}
            >
              <Download size={16} />
              Скачать зашифрованную копию
            </Button>
            <div className="code-block">
              <code>
                npm run rescue -- decrypt --backup backup.json --key-file
                rescue.txt --output credentials.json --allow-plaintext
              </code>
            </div>
            <p>
              При потере доступа владельца используйте команду{" "}
              <code>recover-owner</code> по инструкции из README. Доступ к базе
              без rescue-ключа не расшифрует записи.
            </p>
          </section>
        )}
      </div>
      <div className="footnote">
        <ShieldCheck size={15} />
        Блокируйте хранилище вручную перед уходом. Переключение вкладок и
        бездействие не блокируют записи.
      </div>
    </div>
  );
}
const labels: Record<string, string> = {
  "vault.created": "Хранилище создано",
  "auth.login": "Вход в аккаунт",
  "auth.failed": "Неудачный вход",
  "record.created": "Запись создана",
  "record.updated": "Запись обновлена",
  "record.revealed": "Секрет открыт",
  "record.copied": "Секрет скопирован",
  "record.trashed": "Запись в корзине",
  "record.restored": "Запись восстановлена",
  "member.invited": "Создано приглашение",
  "member.joined": "Участник зарегистрирован",
  "member.approved": "Доступ выдан",
  "member.revoked": "Участник отключён, ключ сменён",
  "member.recovery.requested": "Запрошено восстановление",
  "owner.rescue": "Доступ владельца восстановлен через CLI",
  "vault.backup": "Скачана зашифрованная копия",
  "auth.passkey.added": "Passkey подключён",
  "auth.passkey.removed": "Passkey удалён",
  "auth.browser.trusted": "Браузер запомнен",
  "auth.browser.unlocked": "Хранилище открыто доверенным браузером",
  "auth.browser.revoked": "Доверие браузеру отозвано",
  "auth.password.changed": "Пароль аккаунта изменён",
  "auth.password.disabled": "Парольный вход отключён",
  "auth.provider.linked": "Подключён внешний аккаунт",
  "identity.master.changed": "Пароль изменён",
};
export function Activity() {
  const [rows, setRows] = useState<
      {
        id: string;
        action: string;
        target: string | null;
        displayName: string;
        createdAt: string;
      }[]
    >([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const latestLoad = useRef(0);
  function load() {
    const request = ++latestLoad.current;
    setLoading(true);
    setError("");
    return api<typeof rows>("/audit")
      .then((result) => {
        if (mounted.current && request === latestLoad.current) setRows(result);
      })
      .catch((e) => {
        if (mounted.current && request === latestLoad.current)
          setError(e.message);
      })
      .finally(() => {
        if (mounted.current && request === latestLoad.current)
          setLoading(false);
      });
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      latestLoad.current += 1;
    };
  }, []);
  return (
    <div className="page-body">
      <PageHeader title="Журнал действий" />
      <p className="notice">
        Последние 200 событий. Содержимое секретов в журнал не попадает.
      </p>
      {error && (
        <div role="alert" className="error-message">
          {error}
        </div>
      )}
      {error && (
        <Button variant="outline" size="sm" disabled={loading} onClick={load}>
          Повторить загрузку
        </Button>
      )}
      <Card
        className="table-frame activity-card gap-0 py-0"
        aria-busy={loading}
      >
        <CardHeadRow
          title="События"
          count={loading ? undefined : rows.length}
        />
        <Table scrollLabel="Журнал действий">
          <TableHeader>
            <TableRow>
              <TableHead>Событие</TableHead>
              <TableHead>Участник</TableHead>
              <TableHead>Время</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableLoading columns={3} />}
            {!loading &&
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{labels[r.action] ?? r.action}</TableCell>
                  <TableCell>{r.displayName}</TableCell>
                  <TableCell className="muted">
                    {new Date(r.createdAt).toLocaleString("ru")}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        {!loading && !rows.length && !error && (
          <div className="empty-state">
            <h2>Событий пока нет</h2>
            <p>Действия команды появятся здесь.</p>
          </div>
        )}
      </Card>
      <p className="footnote">
        Открытие и копирование фиксируются штатным интерфейсом. Журнал не может
        учесть чтение данных вне приложения.
      </p>
    </div>
  );
}
