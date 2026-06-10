---
name: update-pdf
description: Regenerate DockTools PDF docs from the Python generator scripts, commit, and push
disable-model-invocation: true
---

Ask the user: "What changed? (brief note for the commit message)"

Then:
1. Run `python3 generate_deployment_plan.py` from the project root
2. Run `python3 generate_hyperv_plan_v2.py` from the project root
3. Stage the .pdf and .py files:
   `git add generate_deployment_plan.py DockTools_HyperV_Deployment_Plan.pdf generate_hyperv_plan_v2.py HyperV_VM_PowerShell_Guide_v2.pdf`
4. Commit with message: `Update PDFs: <user's note>`
5. Push to origin
