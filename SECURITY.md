# Security

- **Report vulnerabilities privately** via GitHub's "Report a vulnerability" (Security tab), not in public issues.
- **Vaults are private data.** Hippocampus is designed so that your vault lives in its own private repository. Never attach real vault files, inbox episodes, or `secrets/*.age` files to issues or PRs.
- **Secrets:** secret facts are encrypted with [age](https://age-encryption.org). The private identity lives outside the vault (default `~/.config/hippocampus/age-identity.txt`). Back it up; without it, secret facts can't be recovered.
- **Known limitation:** an agent that commits an episode containing a secret to your vault repo leaves it in that repo's git history, even after the curator encrypts and redacts it.
