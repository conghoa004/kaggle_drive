
        if ! kill -0 "${pid}" 2>/dev/null; then
            rm -f "${CLOUDFLARED_PID_FILE}"
            print_error "cloudflared stopped unexpectedly. Check ${CLOUDFLARED_LOG}"
            exit 1
        fi
        sleep 1
    done

    if [[ -z "${TUNNEL_URL}" ]]; then
        TUNNEL_URL="URL not detected; check ${CLOUDFLARED_LOG}"
        print_error "Could not detect the Quick Tunnel URL."
    else
        print_info "Quick Tunnel URL: ${TUNNEL_URL}"
    fi
}

start_named_tunnel() {
    print_info "Starting Cloudflare Named Tunnel..."

    : > "${CLOUDFLARED_LOG}"
    nohup "${CLOUDFLARED_BIN}" tunnel run \
        --token "${TUNNEL_TOKEN}" \
        --no-autoupdate \
        >> "${CLOUDFLARED_LOG}" 2>&1 < /dev/null &

    local pid=$!
    printf '%s\n' "${pid}" > "${CLOUDFLARED_PID_FILE}"
    sleep 2

    if ! kill -0 "${pid}" 2>/dev/null; then
        rm -f "${CLOUDFLARED_PID_FILE}"
        print_error "Named Tunnel failed to start. Check ${CLOUDFLARED_LOG}"
        exit 1
    fi

    TUNNEL_URL="Named Tunnel is running; use the hostname configured in Cloudflare."
    print_info "Named Tunnel started (PID ${pid})."
}

install_extensions() {
    local extensions=(
        ms-python.python
        ms-python.vscode-pylance
        dbaeumer.vscode-eslint
        esbenp.prettier-vscode
        bmewburn.vscode-intelephense-client
        mtxr.sqltools
        ms-azuretools.vscode-docker
        eamodio.gitlens
    )

    print_info "Installing recommended extensions..."
    local extension
    for extension in "${extensions[@]}"; do
        print_info "Installing ${extension}..."
        "${CODE_SERVER_BIN}" --install-extension "${extension}" --force || true
    done
}

print_connection_details() {
    echo ""
    echo "Services started"
    echo "================"
    echo "Local URL: http://127.0.0.1:${PORT}"
    echo "Workspace: ${WORKSPACE}"
    echo "Code-server log: ${CODE_SERVER_LOG}"
    if [[ "${TUNNEL_ENABLED}" == true ]]; then
        echo "Cloudflare Tunnel: ${TUNNEL_URL}"
        echo "Cloudflared log: ${CLOUDFLARED_LOG}"
    else
        echo "Cloudflare Tunnel: Disabled"
    fi
    echo "Login file: ${CREDENTIAL_FILE}"
}

cleanup_on_exit() {
    # Used only with --foreground.
    bash "$(dirname "${BASH_SOURCE[0]}")/stop.sh" || true
}

# ==========================================================
# Main
# ==========================================================

main() {
    parse_arguments "$@"
    check_dependencies
    create_directories

    install_code_server
    if [[ "${TUNNEL_ENABLED}" == true ]]; then
        install_cloudflared
    fi

    stop_existing_processes
    create_code_server_config
    setup_workspace

    if [[ "${INSTALL_EXTENSIONS}" == true ]]; then
        install_extensions
    fi

    start_code_server

    if [[ "${TUNNEL_ENABLED}" == true ]]; then
        if [[ -n "${TUNNEL_TOKEN}" ]]; then
            start_named_tunnel
        else
            start_quick_tunnel
        fi
    fi

    update_credential_file
    print_connection_details

    if [[ "${FOREGROUND}" == true ]]; then
        trap cleanup_on_exit EXIT INT TERM
        print_info "Running in foreground. Press Ctrl+C to stop."
        local code_server_pid
        code_server_pid="$(cat "${CODE_SERVER_PID_FILE}")"
        wait "${code_server_pid}" || true
    fi
}

main "$@"
