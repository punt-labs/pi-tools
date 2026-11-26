{
  description = "Punt Labs shared pi tools";

  inputs = {
    nixpkgs.url = "nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            name = "pi-tools-dev";

            packages = with pkgs; [
              bashInteractive
              coreutils
              curl
              direnv
              fd
              gh
              git
              gnumake
              jq
              markdownlint-cli2
              nodejs_24
              ripgrep
              shellcheck
            ];

            shellHook = ''
              export PI_TOOLS_NIX_SHELL=1
              echo "pi-tools dev shell: Node $(${pkgs.nodejs_24}/bin/node --version)"
            '';
          };
        });
    };
}
