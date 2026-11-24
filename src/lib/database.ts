// How the database opened at launch (Rust: store::DatabaseStatus, command
// database_status), and what the interface says about it.

type StoreError =
  | { code: "newer_version"; found: number; supported: number }
  | { code: "io"; message: string }
  | { code: "database"; message: string };

export type DatabaseStatus =
  | { state: "ready" }
  /** The damaged file was set aside as `broken` and the backup put back. */
  | { state: "restored"; broken: string; backupTakenMs: number }
  /** The damaged file was set aside and no backup could be read. */
  | { state: "started_empty"; broken: string }
  | { state: "failed"; error: StoreError };

export interface DatabaseMessage {
  /** warning: Kanade works, something was repaired; error: it cannot. */
  tone: "warning" | "error";
  text: string;
}

/** The date of a backup, in words ("24 novembre 2026 à 12:00"). */
export function backupDate(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone,
  }).format(ms);
}

/** What to tell about the database, or null when all is well. */
export function databaseMessage(status: DatabaseStatus, timeZone?: string): DatabaseMessage | null {
  switch (status.state) {
    case "ready":
      return null;
    case "restored":
      return {
        tone: "warning",
        text:
          `La base de Kanade était abîmée : elle a été restaurée depuis la sauvegarde du ` +
          `${backupDate(status.backupTakenMs, timeZone)}. Ce qui a changé depuis est perdu. ` +
          `Le fichier abîmé est gardé : ${status.broken}`,
      };
    case "started_empty":
      return {
        tone: "warning",
        text:
          "La base de Kanade était abîmée et aucune sauvegarde n'a pu être relue : Kanade repart " +
          `d'une base vide. Le fichier abîmé est gardé : ${status.broken}`,
      };
    case "failed":
      return { tone: "error", text: failureText(status.error) };
  }
}

function failureText(error: StoreError): string {
  switch (error.code) {
    case "newer_version":
      return (
        "Cette base vient d'une version plus récente de Kanade : mets Kanade à jour " +
        "(Réglages › Mises à jour). Rien n'a été modifié."
      );
    case "io":
    case "database":
      return `Impossible d'ouvrir la base de Kanade : ${error.message}`;
  }
}
