-- Vista Conecte — Supabase Schema
-- Execute no SQL Editor do Supabase: https://supabase.com/dashboard/project/hckzsblwyabmhzbjdjgx/sql/new

-- Tabela principal de dados dos modelos (estoque, produção, configurações)
CREATE TABLE IF NOT EXISTS vc_modelos (
  id          TEXT PRIMARY KEY,          -- ex: 'macacao-amplo'
  dados       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Habilitar Row Level Security (leitura/escrita pública para uso interno)
ALTER TABLE vc_modelos ENABLE ROW LEVEL SECURITY;

-- Política: qualquer um pode ler e escrever (app interno)
CREATE POLICY "acesso_total" ON vc_modelos
  FOR ALL USING (true) WITH CHECK (true);

-- Habilitar Realtime para sincronização ao vivo
ALTER PUBLICATION supabase_realtime ADD TABLE vc_modelos;

-- Função para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vc_modelos_updated_at
  BEFORE UPDATE ON vc_modelos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
