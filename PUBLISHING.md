# Publicar opencode-checkpoints en npm y GitHub

## 1) Requisitos

- Cuenta en npmjs.com
- Cuenta en GitHub
- Git y Bun instalados

## 2) Validar el paquete localmente

```powershell
bun --version
bun test
bun run build
```

## 3) Preparar versión para publicar

Sube la versión en `package.json` con semver:
- patch: `1.0.0 -> 1.0.1`
- minor: `1.0.0 -> 1.1.0`
- major: `1.0.0 -> 2.0.0`

## 4) Ver qué se publicará

```powershell
npm pack --dry-run
```

## 5) Publicar en npm

```powershell
npm login
npm publish --access public
```

## 6) Inicializar repo git local

```powershell
git init -b main
git add .
git commit -m "feat: initial opencode-checkpoints plugin"
```

## 7) Crear repo en GitHub y conectar remoto

Crea un repo nuevo llamado `opencode-checkpoints` en GitHub y luego ejecuta:

```powershell
git remote add origin https://github.com/<TU_USUARIO>/opencode-checkpoints.git
git push -u origin main
```

## 8) Flujo recomendado en próximas releases

```powershell
# editar codigo
bun test
bun run build
npm version patch
git push --follow-tags
npm publish --access public
```
