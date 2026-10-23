<div align="center">
<img src="docs/images/logo.png" alt="Logo AssetTrack" width="140"/>
🖥️ AssetTrack
Gestión de activos informáticos, simple y centralizada
![Estado]("C:\Users\angel\Downloads\imagenes\Captura de pantalla 2026-10-23 133723.png")
![Licencia]"C:\Users\angel\Downloads\imagenes\Captura de pantalla 2026-10-23 133915.png")
![Node]("C:\Users\angel\Downloads\imagenes\Captura de pantalla 2026-10-23 134222.png")
![PRs]("C:\Users\angel\Downloads\imagenes\Captura de pantalla 2026-10-23 134247.png")
Demo · Características · Instalación · Contribuir
<img src="docs/images/banner.png" alt="Banner de AssetTrack" width="100%"/>
</div>
---
📖 Descripción
AssetTrack es una aplicación web para gestionar el inventario de activos informáticos de una organización: equipos, periféricos, licencias de software, redes y más. Permite saber qué tienes, dónde está, quién lo usa y en qué estado se encuentra, todo desde un único panel.
✨ Características
Función	Descripción
📦 Inventario	Alta, baja y edición de equipos, periféricos y licencias
👤 Asignaciones	Control de qué usuario o departamento tiene cada activo
🔧 Mantenimiento	Registro de incidencias, reparaciones y revisiones programadas
📊 Dashboard	Estadísticas y gráficos en tiempo real
🔔 Alertas	Avisos de garantías y licencias a punto de caducar
🔍 Búsqueda avanzada	Filtros por tipo, estado, ubicación o responsable
📷 Códigos QR	Etiquetado y consulta rápida de cada activo
📄 Informes	Exportación a PDF y Excel
🔐 Roles y permisos	Administrador, técnico y usuario de consulta
🎬 Demo
Panel principal
<img src="docs/images/dashboard.png" alt="Dashboard" width="100%"/>
Inventario de activos
<img src="docs/images/inventario.png" alt="Inventario" width="100%"/>
Detalle de un activo
<img src="docs/images/detalle-activo.png" alt="Detalle de activo" width="100%"/>
Vista móvil
<p align="center">
  <img src="docs/images/movil-1.png" alt="Vista móvil 1" width="30%"/>
  <img src="docs/images/movil-2.png" alt="Vista móvil 2" width="30%"/>
  <img src="docs/images/movil-3.png" alt="Vista móvil 3" width="30%"/>
</p>
> 💡 Si quieres añadir un GIF de demostración: `<img src="docs/images/demo.gif" width="100%"/>`
🛠️ Tecnologías
![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white)
> Ajusta los badges a las tecnologías que uses realmente (PHP, Laravel, Django, MongoDB, etc.).
🏗️ Arquitectura
```
assettrack/
├── client/            # Frontend
│   ├── src/
│   └── public/
├── server/            # Backend / API REST
│   ├── controllers/
│   ├── models/
│   ├── routes/
│   └── middleware/
├── database/          # Scripts SQL
├── docs/images/       # Capturas del README
└── README.md
```
🚀 Instalación
Requisitos previos
Node.js 18 o superior
MySQL 8 o superior
Git
Pasos
```bash
# 1. Clonar el repositorio
git clone https://github.com/tu-usuario/assettrack.git
cd assettrack

# 2. Instalar dependencias
cd server \&\& npm install
cd ../client \&\& npm install

# 3. Configurar variables de entorno
cp server/.env.example server/.env

# 4. Crear la base de datos
mysql -u root -p < database/schema.sql

# 5. Iniciar la aplicación
cd server \&\& npm run dev
cd ../client \&\& npm start
```
La app estará disponible en http://localhost:3000
Variables de entorno (`server/.env`)
```env
PORT=5000
DB\_HOST=localhost
DB\_USER=root
DB\_PASSWORD=tu\_contraseña
DB\_NAME=assettrack
JWT\_SECRET=clave\_secreta
```
👥 Credenciales de prueba
Rol	Usuario	Contraseña
Administrador	admin@demo.com	admin123
Técnico	tecnico@demo.com	tecnico123
🗺️ Roadmap
[x] CRUD de activos
[x] Sistema de usuarios y roles
[x] Dashboard con gráficos
[ ] Generación de códigos QR
[ ] Notificaciones por correo
[ ] App móvil
[ ] Integración con Active Directory
🤝 Contribuir
Haz un fork del proyecto
Crea una rama: `git checkout -b feature/nueva-funcion`
Haz commit: `git commit -m "Añade nueva función"`
Sube la rama: `git push origin feature/nueva-funcion`
Abre un Pull Request
📄 Licencia
Distribuido bajo la licencia MIT. Consulta el archivo LICENSE para más información.
📬 Contacto
Tu Nombre · @tu-usuario · tu@email.com
<div align="center">
⭐ Si te gusta el proyecto, ¡dale una estrella! ⭐
</div>
