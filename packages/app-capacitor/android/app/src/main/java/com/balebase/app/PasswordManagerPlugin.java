package com.balebase.app;

import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePasswordRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPasswordOption;
import androidx.credentials.PasswordCredential;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Saves the password a person just signed in with, and offers it back on the
 * sign-in form (savePassword.ts). The WebView's autofill does neither: sign-in
 * requests go through native HTTP and the page never navigates, so it never
 * sees the form submitted, and its fill requests name the page's
 * https://localhost origin, not the app these passwords are saved for.
 */
@CapacitorPlugin(name = "PasswordManager")
public class PasswordManagerPlugin extends Plugin {
    @PluginMethod
    public void choose(PluginCall call) {
        // Immediately available only: with nothing saved, no sheet appears.
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(new GetPasswordOption())
            .setPreferImmediatelyAvailableCredentials(true)
            .build();
        // Credential Manager shows its account sheet over the activity.
        getBridge().executeOnMainThread(() ->
            CredentialManager.create(getContext()).getCredentialAsync(
                getActivity(),
                request,
                null,
                ContextCompat.getMainExecutor(getContext()),
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(GetCredentialResponse response) {
                        Credential credential = response.getCredential();
                        JSObject result = new JSObject();
                        if (credential instanceof PasswordCredential) {
                            PasswordCredential password = (PasswordCredential) credential;
                            JSObject chosen = new JSObject();
                            chosen.put("username", password.getId());
                            chosen.put("password", password.getPassword());
                            result.put("credential", chosen);
                        }
                        call.resolve(result);
                    }

                    @Override
                    public void onError(GetCredentialException error) {
                        if (
                            error instanceof NoCredentialException ||
                            error instanceof GetCredentialCancellationException
                        ) {
                            call.resolve(new JSObject());
                            return;
                        }
                        call.reject(error.getMessage(), error.getType());
                    }
                }
            )
        );
    }

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
