// POST /api/logout — derruba o cookie. Sem isto, "Sair" limparia só o
// localStorage e a sessão do servidor seguiria válida por 12h.
export const onRequestPost = () => new Response(JSON.stringify({ ok: true }), {
  headers: {
    'Content-Type': 'application/json',
    'Set-Cookie': 'vc_sessao=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
  }
});
