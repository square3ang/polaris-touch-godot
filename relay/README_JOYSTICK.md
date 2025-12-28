# Virtual Joystick Setup Guide

To enable Virtual Joystick support in Polaris Relay so that iOS inputs are recognized as an Xbox 360 controller on Windows, you must install two system components.

> [!WARNING]
> These steps require **Administrator** privileges and a system restart.

## 1. Install ViGEmBus Driver
This driver emulates the physical controller.

1.  Go to the [ViGEmBus Releases Page](https://github.com/ViGEm/ViGEmBus/releases/latest).
2.  Download `ViGEmBus_Setup_x64.msi`.
3.  Run the installer and follow the prompts.

## 2. Install Build Tools
The `vigemclient` library requires C++ compilation.

### Option A: Automatic (Recommended)
Open **PowerShell as Administrator** and run:
```powershell
npm install --global windows-build-tools
```
*   This takes 5-10 minutes.
*   If it hangs indefinitely, use Option B.

### Option B: Manual
1.  Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
2.  Run the installer.
3.  Select **"Desktop development with C++"**.
4.  Install.

## 3. Install the Library
After completing steps 1 and 2, verify by running this in `relay/` folder:
```bash
npm install vigemclient
```

Once successful, let me know and I will implement the controller mapping in `relay.js`.
