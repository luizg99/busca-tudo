/**
 * Normaliza um telefone digitado pelo usuário para só dígitos com DDI.
 * 10 ou 11 dígitos são tratados como números do Brasil (DDD + número) e ganham o prefixo 55.
 * Devolve undefined se não parecer um telefone (10 a 15 dígitos).
 */
export function normalizePhone(raw: string): string | undefined {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return undefined;
  return digits.length <= 11 ? `55${digits}` : digits;
}
