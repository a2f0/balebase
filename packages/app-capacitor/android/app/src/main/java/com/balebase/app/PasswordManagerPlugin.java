package com.balebase.app;

import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePasswordRequest;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.exceptions.CreateCredentialException;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Offers to save the password a person just signed in with (savePassword.ts).
 * The WebView's autofill never asks: sign-in requests go through native HTTP
 * and the page never navigates, so it never sees the form submitted.
 */
@CapacitorPlugin(name = "PasswordManager")
public class PasswordManagerPlugin extends Plugin {
    @PluginMethod
    public void save(PluginCall call) {
        String username = call.getString("username", "");
        String password = call.getString("password", "");
        if (username.isEmpty() || password.isEmpty()) {
            call.reject("A username and password are required.");
            return;
        }
        // Credential Manager shows its save sheet over the activity.
        getBridge().executeOnMainThread(() ->
            CredentialManager.create(getContext()).createCredentialAsync(
                getActivity(),
                new CreatePasswordRequest(username, password),
                null,
                ContextCompat.getMainExecutor(getContext()),
                new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                    @Override
                    public void onResult(CreateCredentialResponse response) {
                        call.resolve();
                    }

                    @Override
                    public void onError(CreateCredentialException error) {
                        call.reject(error.getMessage(), error.getType());
                    }
                }
            )
        );
    }
}
